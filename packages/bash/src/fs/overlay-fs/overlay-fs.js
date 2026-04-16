/**
 * OverlayFs - Copy-on-write filesystem backed by a real directory
 *
 * Reads come from the real filesystem, writes go to an in-memory layer.
 * Changes don't persist to disk and can't escape the root directory.
 *
 * Security: Symlinks are blocked by default (allowSymlinks: false).
 * All real-FS access goes through resolveRealPath_() / resolveRealPathParent_()
 * gates which detect symlink traversal via path comparison and return the
 * canonical path for I/O (closing the TOCTOU gap). New methods must use these
 * gates — never access the real FS directly.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { fromBuffer, getEncoding, toBuffer } from "../encoding.js";
import {
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
  dirname,
  MAX_SYMLINK_DEPTH,
  resolveSymlinkTarget,
  resolvePath as resolveVPath,
  SYMLINK_MODE,
} from "../path-utils.js";
import {
  isPathWithinRoot,
  normalizePath,
  resolveCanonicalPath,
  resolveCanonicalPathNoSymlinks,
  sanitizeFsError,
  sanitizeSymlinkTarget,
  validatePath,
  validateRootDirectory,
} from "../real-fs-utils.js";

/** Error patterns that are safe to pass through (contain virtual paths, not real ones). */
const OVERLAY_PASSTHROUGH_ERRORS = ["ELOOP", "EFBIG", "EPERM"];
/** Default mount point for OverlayFs */
const DEFAULT_MOUNT_POINT = "/home/user/project";
export class OverlayFs {
  root;
  canonicalRoot;
  mountPoint;
  readOnly;
  maxFileReadSize;
  allowSymlinks;
  memory = new Map();
  deleted = new Set();
  constructor(options) {
    // Resolve to absolute path
    this.root = nodePath.resolve(options.root);
    // Normalize mount point (ensure it starts with / and has no trailing /)
    const mp = options.mountPoint ?? DEFAULT_MOUNT_POINT;
    this.mountPoint = mp === "/" ? "/" : mp.replace(/\/+$/, "");
    if (!this.mountPoint.startsWith("/")) {
      throw new Error(`Mount point must be an absolute path: ${mp}`);
    }
    // Set read-only mode
    this.readOnly = options.readOnly ?? false;
    // Set max file read size (default 10MB)
    this.maxFileReadSize = options.maxFileReadSize ?? 10485760;
    // Set symlink policy
    this.allowSymlinks = options.allowSymlinks ?? false;
    // Verify root exists and is a directory
    validateRootDirectory(this.root, "OverlayFs");
    // Compute canonical root (resolves symlinks like /var -> /private/var on macOS)
    this.canonicalRoot = fs.realpathSync(this.root);
    // Create mount point directory structure in memory layer
    this.createMountPointDirs();
  }
  /**
   * Throws an error if the filesystem is in read-only mode.
   */
  assertWritable(operation) {
    if (this.readOnly) {
      throw new Error(`EROFS: read-only file system, ${operation}`);
    }
  }
  /**
   * Create directory entries for the mount point path
   */
  createMountPointDirs() {
    const parts = this.mountPoint.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      if (!this.memory.has(current)) {
        this.memory.set(current, {
          type: "directory",
          mode: DEFAULT_DIR_MODE,
          mtime: new Date(),
        });
      }
    }
    // Also ensure root exists
    if (!this.memory.has("/")) {
      this.memory.set("/", {
        type: "directory",
        mode: DEFAULT_DIR_MODE,
        mtime: new Date(),
      });
    }
  }
  /**
   * Get the mount point for this overlay
   */
  getMountPoint() {
    return this.mountPoint;
  }
  /**
   * Create a virtual directory in memory (sync, for initialization)
   */
  mkdirSync(path, _options) {
    const normalized = normalizePath(path);
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      if (!this.memory.has(current)) {
        this.memory.set(current, {
          type: "directory",
          mode: DEFAULT_DIR_MODE,
          mtime: new Date(),
        });
      }
    }
  }
  /**
   * Create a virtual file in memory (sync, for initialization)
   */
  writeFileSync(path, content) {
    const normalized = normalizePath(path);
    // Ensure parent directories exist
    const parent = this.getDirname(normalized);
    if (parent !== "/") {
      this.mkdirSync(parent);
    }
    const buffer =
      content instanceof Uint8Array
        ? content
        : new TextEncoder().encode(content);
    this.memory.set(normalized, {
      type: "file",
      content: buffer,
      mode: DEFAULT_FILE_MODE,
      mtime: new Date(),
    });
  }
  getDirname(path) {
    const lastSlash = path.lastIndexOf("/");
    return lastSlash === 0 ? "/" : path.slice(0, lastSlash);
  }
  /**
   * Check if a normalized virtual path is under the mount point.
   * Returns the relative path within the mount point, or null if not under it.
   */
  getRelativeToMount(normalizedPath) {
    if (this.mountPoint === "/") {
      // Mount at root - all paths are relative to mount
      return normalizedPath;
    }
    if (normalizedPath === this.mountPoint) {
      return "/";
    }
    if (normalizedPath.startsWith(`${this.mountPoint}/`)) {
      return normalizedPath.slice(this.mountPoint.length);
    }
    return null;
  }
  /**
   * Convert a virtual path to a real filesystem path.
   * Returns null if the path is not under the mount point or would escape the root.
   */
  toRealPath(virtualPath) {
    const normalized = normalizePath(virtualPath);
    // Check if path is under the mount point
    const relativePath = this.getRelativeToMount(normalized);
    if (relativePath === null) {
      return null;
    }
    const realPath = nodePath.join(this.root, relativePath);
    // Security check: ensure path doesn't escape root
    const resolvedReal = nodePath.resolve(realPath);
    if (!isPathWithinRoot(resolvedReal, this.root)) {
      return null;
    }
    return resolvedReal;
  }
  /**
   * Resolve a real-FS path to its canonical form and validate it stays
   * within the sandbox.  Returns the canonical path for I/O, or null if
   * the path escapes the root or traverses a symlink (when !allowSymlinks).
   *
   * Callers MUST use the returned canonical path for subsequent I/O to
   * close the TOCTOU gap between validation and use.
   */
  resolveRealPath_(realPath) {
    if (!realPath) return null;
    if (!this.allowSymlinks) {
      return resolveCanonicalPathNoSymlinks(
        realPath,
        this.root,
        this.canonicalRoot,
      );
    }
    return resolveCanonicalPath(realPath, this.canonicalRoot);
  }
  /**
   * Resolve only the parent directory of a real-FS path, then join with
   * the original basename.  Used by lstat/readlink/existsInOverlay where
   * the final component may itself be a symlink we want to inspect (not
   * follow).  Returns the canonical parent + basename for I/O, or null.
   */
  resolveRealPathParent_(realPath) {
    if (!realPath) return null;
    const parent = nodePath.dirname(realPath);
    const canonicalParent = this.resolveRealPath_(parent);
    if (canonicalParent === null) return null;
    return nodePath.join(canonicalParent, nodePath.basename(realPath));
  }
  sanitizeError(e, virtualPath, operation) {
    sanitizeFsError(e, virtualPath, operation, OVERLAY_PASSTHROUGH_ERRORS);
  }
  ensureParentDirs(path) {
    const dir = dirname(path);
    if (dir === "/") return;
    if (!this.memory.has(dir)) {
      this.ensureParentDirs(dir);
      this.memory.set(dir, {
        type: "directory",
        mode: DEFAULT_DIR_MODE,
        mtime: new Date(),
      });
    }
    // Remove from deleted set if it was there
    this.deleted.delete(dir);
  }
  /**
   * Check if a path exists in the overlay (memory + real fs - deleted)
   */
  async existsInOverlay(virtualPath) {
    const normalized = normalizePath(virtualPath);
    // Deleted in memory layer?
    if (this.deleted.has(normalized)) {
      return false;
    }
    // Exists in memory layer?
    if (this.memory.has(normalized)) {
      return true;
    }
    // Check real filesystem using lstat to avoid following OS-level symlinks.
    // Using access() or stat() would follow symlinks and could leak existence
    // of files outside the sandbox.
    // Validate only the parent directory since lstat doesn't follow the final component.
    // Use the canonical path for I/O to close the TOCTOU gap.
    const canonical = this.resolveRealPathParent_(this.toRealPath(normalized));
    if (!canonical) {
      return false;
    }
    try {
      await fs.promises.lstat(canonical);
      return true;
    } catch {
      return false;
    }
  }
  async readFile(path, options) {
    const buffer = await this.readFileBuffer(path);
    const encoding = getEncoding(options);
    return fromBuffer(buffer, encoding);
  }
  async readFileBuffer(path, seen = new Set()) {
    validatePath(path, "open");
    const normalized = normalizePath(path);
    // Detect symlink loops
    if (seen.has(normalized)) {
      throw new Error(
        `ELOOP: too many levels of symbolic links, open '${path}'`,
      );
    }
    seen.add(normalized);
    // Check if deleted
    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    // Check memory layer first
    const memEntry = this.memory.get(normalized);
    if (memEntry) {
      if (memEntry.type === "symlink") {
        const target = this.resolveSymlink(normalized, memEntry.target);
        return this.readFileBuffer(target, seen);
      }
      if (memEntry.type !== "file") {
        throw new Error(
          `EISDIR: illegal operation on a directory, read '${path}'`,
        );
      }
      return memEntry.content;
    }
    // Fall back to real filesystem.  Use the canonical path for I/O to
    // close the TOCTOU gap between validation and use.
    const canonical = this.resolveRealPath_(this.toRealPath(normalized));
    if (!canonical) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    try {
      const stat = await fs.promises.lstat(canonical);
      if (stat.isSymbolicLink()) {
        if (!this.allowSymlinks) {
          throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        }
        const rawTarget = await fs.promises.readlink(canonical);
        const virtualTarget = this.realTargetToVirtual(normalized, rawTarget);
        const resolvedTarget = this.resolveSymlink(normalized, virtualTarget);
        return this.readFileBuffer(resolvedTarget, seen);
      }
      if (stat.isDirectory()) {
        throw new Error(
          `EISDIR: illegal operation on a directory, read '${path}'`,
        );
      }
      if (this.maxFileReadSize > 0 && stat.size > this.maxFileReadSize) {
        throw new Error(
          `EFBIG: file too large, read '${path}' (${stat.size} bytes, max ${this.maxFileReadSize})`,
        );
      }
      // Use O_NOFOLLOW (when symlinks disabled) to prevent TOCTOU: if the
      // file at `canonical` is swapped for a symlink between lstat and read,
      // O_NOFOLLOW makes the open fail instead of following the symlink.
      const flags = this.allowSymlinks
        ? fs.constants.O_RDONLY
        : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
      const fh = await fs.promises.open(canonical, flags);
      try {
        const content = await fh.readFile();
        return new Uint8Array(content);
      } finally {
        await fh.close();
      }
    } catch (e) {
      const code = e.code;
      if (code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      if (code === "ELOOP") {
        // O_NOFOLLOW caught a symlink swap (TOCTOU defense)
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      this.sanitizeError(e, path, "open");
    }
  }
  async writeFile(path, content, options) {
    validatePath(path, "write");
    this.assertWritable(`write '${path}'`);
    const normalized = normalizePath(path);
    this.ensureParentDirs(normalized);
    const encoding = getEncoding(options);
    const buffer = toBuffer(content, encoding);
    this.memory.set(normalized, {
      type: "file",
      content: buffer,
      mode: DEFAULT_FILE_MODE,
      mtime: new Date(),
    });
    this.deleted.delete(normalized);
  }
  async appendFile(path, content, options) {
    validatePath(path, "append");
    this.assertWritable(`append '${path}'`);
    const normalized = normalizePath(path);
    const encoding = getEncoding(options);
    const newBuffer = toBuffer(content, encoding);
    // Try to read existing content
    let existingBuffer;
    try {
      existingBuffer = await this.readFileBuffer(normalized);
    } catch {
      existingBuffer = new Uint8Array(0);
    }
    const combined = new Uint8Array(existingBuffer.length + newBuffer.length);
    combined.set(existingBuffer);
    combined.set(newBuffer, existingBuffer.length);
    this.ensureParentDirs(normalized);
    this.memory.set(normalized, {
      type: "file",
      content: combined,
      mode: DEFAULT_FILE_MODE,
      mtime: new Date(),
    });
    this.deleted.delete(normalized);
  }
  async exists(path) {
    if (path.includes("\0")) {
      return false;
    }
    return this.existsInOverlay(path);
  }
  async stat(path, seen = new Set()) {
    validatePath(path, "stat");
    const normalized = normalizePath(path);
    // Detect symlink loops
    if (seen.has(normalized)) {
      throw new Error(
        `ELOOP: too many levels of symbolic links, stat '${path}'`,
      );
    }
    seen.add(normalized);
    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }
    // Check memory layer first
    const entry = this.memory.get(normalized);
    if (entry) {
      // Follow symlinks
      if (entry.type === "symlink") {
        const target = this.resolveSymlink(normalized, entry.target);
        return this.stat(target, seen);
      }
      let size = 0;
      if (entry.type === "file") {
        size = entry.content.length;
      }
      return {
        isFile: entry.type === "file",
        isDirectory: entry.type === "directory",
        isSymbolicLink: false,
        mode: entry.mode,
        size,
        mtime: entry.mtime,
      };
    }
    // Fall back to real filesystem.  Use the canonical path for I/O to
    // close the TOCTOU gap between validation and use.
    const canonical = this.resolveRealPath_(this.toRealPath(normalized));
    if (!canonical) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }
    try {
      // Use lstat to avoid following OS-level symlinks directly.
      // If it's a symlink, resolve through the virtual layer to prevent
      // leaking metadata about files outside the sandbox.
      const lstatResult = await fs.promises.lstat(canonical);
      if (lstatResult.isSymbolicLink()) {
        if (!this.allowSymlinks) {
          throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
        }
        const rawTarget = await fs.promises.readlink(canonical);
        const virtualTarget = this.realTargetToVirtual(normalized, rawTarget);
        const resolvedTarget = this.resolveSymlink(normalized, virtualTarget);
        return this.stat(resolvedTarget, seen);
      }
      return {
        isFile: lstatResult.isFile(),
        isDirectory: lstatResult.isDirectory(),
        isSymbolicLink: false,
        mode: lstatResult.mode,
        size: lstatResult.size,
        mtime: lstatResult.mtime,
      };
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
      }
      this.sanitizeError(e, path, "stat");
    }
  }
  async lstat(path) {
    validatePath(path, "lstat");
    const normalized = normalizePath(path);
    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
    }
    // Check memory layer first
    const entry = this.memory.get(normalized);
    if (entry) {
      if (entry.type === "symlink") {
        return {
          isFile: false,
          isDirectory: false,
          isSymbolicLink: true,
          mode: entry.mode,
          size: entry.target.length,
          mtime: entry.mtime,
        };
      }
      let size = 0;
      if (entry.type === "file") {
        size = entry.content.length;
      }
      return {
        isFile: entry.type === "file",
        isDirectory: entry.type === "directory",
        isSymbolicLink: false,
        mode: entry.mode,
        size,
        mtime: entry.mtime,
      };
    }
    // Fall back to real filesystem
    // For lstat, validate only the parent directory (lstat should not follow
    // the final component, so we only need the parent to be within sandbox).
    // Use the canonical path for I/O to close the TOCTOU gap.
    const canonical = this.resolveRealPathParent_(this.toRealPath(normalized));
    if (!canonical) {
      throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
    }
    try {
      const stat = await fs.promises.lstat(canonical);
      return {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
        mode: stat.mode,
        size: stat.size,
        mtime: stat.mtime,
      };
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
      }
      this.sanitizeError(e, path, "lstat");
    }
  }
  resolveSymlink(symlinkPath, target) {
    return resolveSymlinkTarget(symlinkPath, target);
  }
  /**
   * Convert a real-fs symlink target to a virtual target suitable for resolveSymlink.
   * Handles absolute real-fs paths that point within the root by converting them
   * to virtual paths relative to the mount point.
   */
  realTargetToVirtual(_symlinkVirtualPath, rawTarget) {
    const result = sanitizeSymlinkTarget(rawTarget, this.canonicalRoot);
    if (result.withinRoot) {
      if (!nodePath.isAbsolute(rawTarget)) {
        // Relative targets work the same way in both real and virtual fs
        return rawTarget;
      }
      // Target is within root - convert to virtual path under mount point
      const relativePath = result.relativePath;
      if (this.mountPoint === "/") {
        return relativePath;
      }
      return `${this.mountPoint}${relativePath}`;
    }
    // Target is outside root - return sanitized basename
    return result.safeName;
  }
  async mkdir(path, options) {
    validatePath(path, "mkdir");
    this.assertWritable(`mkdir '${path}'`);
    const normalized = normalizePath(path);
    // Check if it exists (in memory or real fs)
    const exists = await this.existsInOverlay(normalized);
    if (exists) {
      if (!options?.recursive) {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
      return;
    }
    // Check parent exists
    const parent = dirname(normalized);
    if (parent !== "/") {
      const parentExists = await this.existsInOverlay(parent);
      if (!parentExists) {
        if (options?.recursive) {
          await this.mkdir(parent, { recursive: true });
        } else {
          throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
        }
      }
    }
    this.memory.set(normalized, {
      type: "directory",
      mode: DEFAULT_DIR_MODE,
      mtime: new Date(),
    });
    this.deleted.delete(normalized);
  }
  /**
   * Core readdir implementation that returns entries with file types.
   * Both readdir and readdirWithFileTypes use this shared implementation.
   */
  async readdirCore(path, normalized) {
    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    const entriesMap = new Map();
    const deletedChildren = new Set();
    // Collect deleted entries that are direct children of this path
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    for (const deletedPath of this.deleted) {
      if (deletedPath.startsWith(prefix)) {
        const rest = deletedPath.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name && !rest.includes("/", name.length)) {
          deletedChildren.add(name);
        }
      }
    }
    // Add entries from memory layer (with type info)
    for (const [memPath, entry] of this.memory) {
      if (memPath === normalized) continue;
      if (memPath.startsWith(prefix)) {
        const rest = memPath.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name && !deletedChildren.has(name) && !rest.includes("/", 1)) {
          // Direct child
          entriesMap.set(name, {
            name,
            isFile: entry.type === "file",
            isDirectory: entry.type === "directory",
            isSymbolicLink: entry.type === "symlink",
          });
        }
      }
    }
    // Add entries from real filesystem with file types.
    // Use the canonical path for I/O to close the TOCTOU gap.
    const canonical = this.resolveRealPath_(this.toRealPath(normalized));
    if (canonical) {
      try {
        // Defense-in-depth lstat check: if the directory at `canonical` was
        // replaced with a symlink between resolveRealPath_() and readdir,
        // lstat detects it.  Node.js has no fd-based readdir, so a tiny
        // TOCTOU window remains between this lstat and the readdir below.
        if (!this.allowSymlinks) {
          const dirStat = await fs.promises.lstat(canonical);
          if (dirStat.isSymbolicLink()) {
            // Treat as non-existent — don't leak real-FS entries
            if (!this.memory.has(normalized)) {
              throw new Error(
                `ENOENT: no such file or directory, scandir '${path}'`,
              );
            }
            return entriesMap;
          }
        }
        const realEntries = await fs.promises.readdir(canonical, {
          withFileTypes: true,
        });
        for (const dirent of realEntries) {
          if (
            !deletedChildren.has(dirent.name) &&
            !entriesMap.has(dirent.name)
          ) {
            entriesMap.set(dirent.name, {
              name: dirent.name,
              isFile: dirent.isFile(),
              isDirectory: dirent.isDirectory(),
              isSymbolicLink: dirent.isSymbolicLink(),
            });
          }
        }
      } catch (e) {
        // If it's ENOENT and we don't have it in memory, throw
        if (e.code === "ENOENT") {
          if (!this.memory.has(normalized)) {
            throw new Error(
              `ENOENT: no such file or directory, scandir '${path}'`,
            );
          }
        } else if (e.code !== "ENOTDIR") {
          this.sanitizeError(e, path, "scandir");
        }
      }
    }
    return entriesMap;
  }
  /**
   * Follow symlinks to resolve the final directory path.
   * Returns outsideOverlay: true if the symlink points outside the overlay or
   * the resolved target doesn't exist (security - broken symlinks return []).
   */
  async resolveForReaddir(path, followedSymlink = false) {
    let normalized = normalizePath(path);
    const seen = new Set();
    let didFollowSymlink = followedSymlink;
    // Check memory layer first
    let entry = this.memory.get(normalized);
    while (entry && entry.type === "symlink") {
      if (seen.has(normalized)) {
        throw new Error(
          `ELOOP: too many levels of symbolic links, scandir '${path}'`,
        );
      }
      seen.add(normalized);
      didFollowSymlink = true;
      normalized = this.resolveSymlink(normalized, entry.target);
      entry = this.memory.get(normalized);
    }
    // If in memory and not a symlink, we're done
    if (entry) {
      return { normalized, outsideOverlay: false };
    }
    // Check if the resolved path is within the overlay's mount point
    const relativePath = this.getRelativeToMount(normalized);
    if (relativePath === null) {
      // Path is outside the overlay - return indicator for secure handling
      return { normalized, outsideOverlay: true };
    }
    // Check real filesystem.  Use the canonical path for I/O to close the
    // TOCTOU gap between validation and use.
    const canonical = this.resolveRealPath_(this.toRealPath(normalized));
    if (!canonical) {
      // Path doesn't map to real filesystem (security check failed)
      return { normalized, outsideOverlay: true };
    }
    try {
      const stat = await fs.promises.lstat(canonical);
      if (stat.isSymbolicLink()) {
        if (!this.allowSymlinks) {
          return { normalized, outsideOverlay: true };
        }
        const rawTarget = await fs.promises.readlink(canonical);
        const virtualTarget = this.realTargetToVirtual(normalized, rawTarget);
        const resolvedTarget = this.resolveSymlink(normalized, virtualTarget);
        return this.resolveForReaddir(resolvedTarget, true);
      }
      // Path exists on real filesystem
      return { normalized, outsideOverlay: false };
    } catch {
      // Path doesn't exist on real fs
      if (didFollowSymlink) {
        // Followed a symlink but target doesn't exist - broken symlink, return []
        return { normalized, outsideOverlay: true };
      }
      // No symlink was followed, let readdirCore handle the ENOENT
      return { normalized, outsideOverlay: false };
    }
  }
  async readdir(path) {
    validatePath(path, "scandir");
    const { normalized, outsideOverlay } = await this.resolveForReaddir(path);
    if (outsideOverlay) {
      // Security: symlink points outside overlay, return empty
      return [];
    }
    const entriesMap = await this.readdirCore(path, normalized);
    // Sort using case-sensitive comparison to match native behavior
    return Array.from(entriesMap.keys()).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
  }
  async readdirWithFileTypes(path) {
    validatePath(path, "scandir");
    const { normalized, outsideOverlay } = await this.resolveForReaddir(path);
    if (outsideOverlay) {
      // Security: symlink points outside overlay, return empty
      return [];
    }
    const entriesMap = await this.readdirCore(path, normalized);
    // Sort using case-sensitive comparison to match native behavior
    return Array.from(entriesMap.values()).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }
  async rm(path, options) {
    validatePath(path, "rm");
    this.assertWritable(`rm '${path}'`);
    const normalized = normalizePath(path);
    const exists = await this.existsInOverlay(normalized);
    if (!exists) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }
    // Check if it's a directory
    try {
      const stat = await this.stat(normalized);
      if (stat.isDirectory) {
        const children = await this.readdir(normalized);
        if (children.length > 0) {
          if (!options?.recursive) {
            throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
          }
          for (const child of children) {
            const childPath =
              normalized === "/" ? `/${child}` : `${normalized}/${child}`;
            await this.rm(childPath, options);
          }
        }
      }
    } catch (e) {
      // Re-throw ENOTEMPTY and other intentional errors.
      // Only swallow errors from stat/readdir failing (e.g., ENOENT on real-fs).
      if (
        e instanceof Error &&
        (e.message.includes("ENOTEMPTY") || e.message.includes("EISDIR"))
      ) {
        throw e;
      }
      // If stat fails, we'll just mark it as deleted
    }
    // Remove from memory layer
    this.memory.delete(normalized);
    // Only add a tombstone when hiding a real-FS path.
    // For memory-only files there's nothing to hide, so skip the tombstone
    // to prevent unbounded growth of the deleted set.
    if (this.existsOnRealFs(normalized)) {
      this.deleted.add(normalized);
    }
  }
  /**
   * Check (synchronously) whether a path exists on the real filesystem.
   * Used to decide whether a tombstone is needed after deletion.
   */
  existsOnRealFs(virtualPath) {
    const realPath = this.toRealPath(virtualPath);
    const canonical = this.resolveRealPathParent_(realPath);
    if (!canonical) return false;
    try {
      fs.lstatSync(canonical);
      return true;
    } catch {
      return false;
    }
  }
  async cp(src, dest, options) {
    validatePath(src, "cp");
    validatePath(dest, "cp");
    this.assertWritable(`cp '${dest}'`);
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    const srcExists = await this.existsInOverlay(srcNorm);
    if (!srcExists) {
      throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
    }
    const srcStat = await this.stat(srcNorm);
    if (srcStat.isFile) {
      const content = await this.readFileBuffer(srcNorm);
      await this.writeFile(destNorm, content);
    } else if (srcStat.isDirectory) {
      if (!options?.recursive) {
        throw new Error(`EISDIR: is a directory, cp '${src}'`);
      }
      await this.mkdir(destNorm, { recursive: true });
      const children = await this.readdir(srcNorm);
      for (const child of children) {
        const srcChild = srcNorm === "/" ? `/${child}` : `${srcNorm}/${child}`;
        const destChild =
          destNorm === "/" ? `/${child}` : `${destNorm}/${child}`;
        await this.cp(srcChild, destChild, options);
      }
    }
  }
  async mv(src, dest) {
    this.assertWritable(`mv '${dest}'`);
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }
  resolvePath(base, rel) {
    return resolveVPath(base, rel);
  }
  getAllPaths() {
    // This is expensive for overlay fs, but we can return what's in memory
    // plus scan the real filesystem
    const paths = new Set(this.memory.keys());
    // Remove deleted paths
    for (const deleted of this.deleted) {
      paths.delete(deleted);
    }
    // Add paths from real filesystem (this is a sync operation, be careful)
    this.scanRealFs("/", paths);
    return Array.from(paths);
  }
  scanRealFs(virtualDir, paths) {
    if (this.deleted.has(virtualDir)) return;
    // Use the canonical path for I/O to close the TOCTOU gap.
    const canonical = this.resolveRealPath_(this.toRealPath(virtualDir));
    if (!canonical) return;
    try {
      const entries = fs.readdirSync(canonical);
      for (const entry of entries) {
        const virtualPath =
          virtualDir === "/" ? `/${entry}` : `${virtualDir}/${entry}`;
        if (this.deleted.has(virtualPath)) continue;
        paths.add(virtualPath);
        const entryPath = nodePath.join(canonical, entry);
        // Use lstatSync to avoid following OS symlinks that could point
        // outside the sandbox root. Symlinks are listed but not traversed.
        const stat = fs.lstatSync(entryPath);
        if (stat.isDirectory()) {
          this.scanRealFs(virtualPath, paths);
        }
      }
    } catch {
      // Ignore errors
    }
  }
  async chmod(path, mode) {
    validatePath(path, "chmod");
    this.assertWritable(`chmod '${path}'`);
    const normalized = normalizePath(path);
    const exists = await this.existsInOverlay(normalized);
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
    }
    // If in memory, update there
    const entry = this.memory.get(normalized);
    if (entry) {
      entry.mode = mode;
      return;
    }
    // If from real fs, we need to copy to memory layer first
    const stat = await this.stat(normalized);
    if (stat.isFile) {
      const content = await this.readFileBuffer(normalized);
      this.memory.set(normalized, {
        type: "file",
        content,
        mode,
        mtime: new Date(),
      });
    } else if (stat.isDirectory) {
      this.memory.set(normalized, {
        type: "directory",
        mode,
        mtime: new Date(),
      });
    }
  }
  async symlink(target, linkPath) {
    if (!this.allowSymlinks) {
      throw new Error(`EPERM: operation not permitted, symlink '${linkPath}'`);
    }
    validatePath(linkPath, "symlink");
    this.assertWritable(`symlink '${linkPath}'`);
    const normalized = normalizePath(linkPath);
    const exists = await this.existsInOverlay(normalized);
    if (exists) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }
    this.ensureParentDirs(normalized);
    this.memory.set(normalized, {
      type: "symlink",
      target,
      mode: SYMLINK_MODE,
      mtime: new Date(),
    });
    this.deleted.delete(normalized);
  }
  async link(existingPath, newPath) {
    validatePath(existingPath, "link");
    validatePath(newPath, "link");
    this.assertWritable(`link '${newPath}'`);
    const existingNorm = normalizePath(existingPath);
    const newNorm = normalizePath(newPath);
    const existingExists = await this.existsInOverlay(existingNorm);
    if (!existingExists) {
      throw new Error(
        `ENOENT: no such file or directory, link '${existingPath}'`,
      );
    }
    const existingStat = await this.stat(existingNorm);
    if (!existingStat.isFile) {
      throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);
    }
    const newExists = await this.existsInOverlay(newNorm);
    if (newExists) {
      throw new Error(`EEXIST: file already exists, link '${newPath}'`);
    }
    // Copy content to new location
    const content = await this.readFileBuffer(existingNorm);
    this.ensureParentDirs(newNorm);
    this.memory.set(newNorm, {
      type: "file",
      content,
      mode: existingStat.mode,
      mtime: new Date(),
    });
    this.deleted.delete(newNorm);
  }
  async readlink(path) {
    validatePath(path, "readlink");
    const normalized = normalizePath(path);
    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }
    // Check memory layer first
    const entry = this.memory.get(normalized);
    if (entry) {
      if (entry.type !== "symlink") {
        throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
      }
      return entry.target;
    }
    // Fall back to real filesystem
    // For readlink, validate only the parent directory (readlink reads the
    // symlink itself, it doesn't follow it - same pattern as lstat).
    // Use the canonical path for I/O to close the TOCTOU gap.
    const canonical = this.resolveRealPathParent_(this.toRealPath(normalized));
    if (!canonical) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }
    try {
      const rawTarget = await fs.promises.readlink(canonical);
      // For relative targets, verify the resolved target stays within root.
      // sanitizeSymlinkTarget treats all relative targets as "within root"
      // without resolving them, so a target like "../../../etc/passwd" would
      // be returned as-is, leaking sandbox structure information.
      if (!nodePath.isAbsolute(rawTarget)) {
        const resolvedReal = nodePath.resolve(
          nodePath.dirname(canonical),
          rawTarget,
        );
        let canonicalTarget;
        try {
          canonicalTarget = fs.realpathSync(resolvedReal);
        } catch {
          canonicalTarget = resolvedReal;
        }
        if (!isPathWithinRoot(canonicalTarget, this.canonicalRoot)) {
          return nodePath.basename(rawTarget);
        }
      }
      return this.realTargetToVirtual(normalized, rawTarget);
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(
          `ENOENT: no such file or directory, readlink '${path}'`,
        );
      }
      if (e.code === "EINVAL") {
        throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
      }
      this.sanitizeError(e, path, "readlink");
    }
  }
  /**
   * Resolve all symlinks in a path to get the canonical physical path.
   * This is equivalent to POSIX realpath().
   */
  async realpath(path) {
    validatePath(path, "realpath");
    const normalized = normalizePath(path);
    const seen = new Set();
    // Helper to resolve symlinks iteratively
    const resolveAll = async (p) => {
      const parts = p === "/" ? [] : p.slice(1).split("/");
      let resolved = "";
      for (const part of parts) {
        resolved = `${resolved}/${part}`;
        // Check for loops
        if (seen.has(resolved)) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, realpath '${path}'`,
          );
        }
        // Check if deleted
        if (this.deleted.has(resolved)) {
          throw new Error(
            `ENOENT: no such file or directory, realpath '${path}'`,
          );
        }
        // Check memory layer first
        let entry = this.memory.get(resolved);
        let loopCount = 0;
        const maxLoops = MAX_SYMLINK_DEPTH;
        while (entry && entry.type === "symlink" && loopCount < maxLoops) {
          seen.add(resolved);
          resolved = this.resolveSymlink(resolved, entry.target);
          loopCount++;
          if (seen.has(resolved)) {
            throw new Error(
              `ELOOP: too many levels of symbolic links, realpath '${path}'`,
            );
          }
          if (this.deleted.has(resolved)) {
            throw new Error(
              `ENOENT: no such file or directory, realpath '${path}'`,
            );
          }
          entry = this.memory.get(resolved);
        }
        if (loopCount >= maxLoops) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, realpath '${path}'`,
          );
        }
        // If not in memory, check real filesystem.
        // Use canonical paths for I/O to close the TOCTOU gap.
        if (!entry) {
          const realPath = this.toRealPath(resolved);
          const canonical = this.resolveRealPath_(realPath);
          if (canonical) {
            try {
              const stat = await fs.promises.lstat(canonical);
              if (stat.isSymbolicLink()) {
                if (!this.allowSymlinks) {
                  throw new Error(
                    `ENOENT: no such file or directory, realpath '${path}'`,
                  );
                }
                const rawTarget = await fs.promises.readlink(canonical);
                const virtualTarget = this.realTargetToVirtual(
                  resolved,
                  rawTarget,
                );
                seen.add(resolved);
                resolved = this.resolveSymlink(resolved, virtualTarget);
                // Continue resolving from the new path
                // We need to restart from this point to handle nested symlinks
                return resolveAll(resolved);
              }
            } catch (e) {
              if (e.code === "ENOENT") {
                throw new Error(
                  `ENOENT: no such file or directory, realpath '${path}'`,
                );
              }
              this.sanitizeError(e, path, "realpath");
            }
          } else if (!this.allowSymlinks) {
            // resolveRealPath_ rejected this path (symlink traversal
            // detected). Use parent validation + lstat to check whether
            // this specific component is a symlink and throw ENOENT.
            const canonicalWithBase = this.resolveRealPathParent_(realPath);
            if (canonicalWithBase) {
              try {
                const stat = await fs.promises.lstat(canonicalWithBase);
                if (stat.isSymbolicLink()) {
                  throw new Error(
                    `ENOENT: no such file or directory, realpath '${path}'`,
                  );
                }
              } catch (e) {
                if (
                  e.message?.includes("ENOENT") ||
                  e.message?.includes("ELOOP")
                ) {
                  throw new Error(
                    `ENOENT: no such file or directory, realpath '${path}'`,
                  );
                }
                this.sanitizeError(e, path, "realpath");
              }
            }
          }
        }
      }
      return resolved || "/";
    };
    const result = await resolveAll(normalized);
    // Verify the final path exists
    const exists = await this.existsInOverlay(result);
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    }
    return result;
  }
  /**
   * Set access and modification times of a file
   * @param path - The file path
   * @param _atime - Access time (ignored, kept for API compatibility)
   * @param mtime - Modification time
   */
  async utimes(path, _atime, mtime) {
    validatePath(path, "utimes");
    this.assertWritable(`utimes '${path}'`);
    const normalized = normalizePath(path);
    const exists = await this.existsInOverlay(normalized);
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
    }
    // If in memory, update there
    const entry = this.memory.get(normalized);
    if (entry) {
      entry.mtime = mtime;
      return;
    }
    // If from real fs, we need to copy to memory layer first
    const stat = await this.stat(normalized);
    if (stat.isFile) {
      const content = await this.readFileBuffer(normalized);
      this.memory.set(normalized, {
        type: "file",
        content,
        mode: stat.mode,
        mtime,
      });
    } else if (stat.isDirectory) {
      this.memory.set(normalized, {
        type: "directory",
        mode: stat.mode,
        mtime,
      });
    }
  }
}
