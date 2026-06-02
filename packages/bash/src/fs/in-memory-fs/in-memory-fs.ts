import { fromBuffer, getEncoding, toBuffer } from "../encoding.js";
import type {
  BufferEncoding,
  CpOptions,
  DirectoryEntry,
  DirentEntry,
  FileContent,
  FileEntry,
  FileInit,
  FileSystemSnapshot,
  FsEntry,
  FsStat,
  IFileSystem,
  InitialFiles,
  LazyFileEntry,
  LazyFileProvider,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  SymlinkEntry,
  WriteFileOptions,
} from "../interface.js";
import {
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
  dirname,
  joinPath,
  MAX_SYMLINK_DEPTH,
  normalizePath,
  resolvePath,
  resolveSymlinkTarget,
  SYMLINK_MODE,
  validatePath,
} from "../path-utils.js";

// Re-export for backwards compatibility
export type {
  BufferEncoding,
  DirectoryEntry,
  FileContent,
  FileEntry,
  FsEntry,
  FsStat,
  IFileSystem,
  LazyFileEntry,
  SymlinkEntry,
};

export interface FsData {
  [path: string]: FsEntry;
}

// Text encoder for legacy string content conversion
const textEncoder = new TextEncoder();

/**
 * Type guard to check if a value is a FileInit object
 */
function isFileInit(
  value: FileContent | FileInit | LazyFileProvider,
): value is FileInit {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    "content" in value
  );
}

export class InMemoryFs implements IFileSystem {
  private data: Map<string, FsEntry> = new Map();
  private childIndex: Map<string, Set<string>> = new Map();

  private addToChildIndex(parentPath: string, childName: string): void {
    let children = this.childIndex.get(parentPath);
    if (!children) {
      children = new Set();
      this.childIndex.set(parentPath, children);
    }
    children.add(childName);
  }

  private removeFromChildIndex(parentPath: string, childName: string): void {
    const children = this.childIndex.get(parentPath);
    if (children) {
      children.delete(childName);
    }
  }

  private rebuildChildIndex(): void {
    this.childIndex.clear();
    for (const [path] of this.data.entries()) {
      if (path === "/") {
        if (!this.childIndex.has("/")) {
          this.childIndex.set("/", new Set());
        }
        continue;
      }
      const parent = dirname(path);
      const name = path.slice(parent === "/" ? 1 : parent.length + 1);
      this.addToChildIndex(parent, name);
      const entry = this.data.get(path);
      if (entry?.type === "directory" && !this.childIndex.has(path)) {
        this.childIndex.set(path, new Set());
      }
    }
  }

  constructor(initialFiles?: InitialFiles) {
    this.data.set("/", {
      type: "directory",
      mode: DEFAULT_DIR_MODE,
      mtime: new Date(),
    });
    this.childIndex.set("/", new Set());

    if (initialFiles) {
      for (const [path, value] of Object.entries(initialFiles)) {
        const normalized = normalizePath(path);
        const parent = dirname(normalized);
        if (parent !== "/") {
          this.mkdirSync(parent, { recursive: true });
        }

        if (typeof value === "function") {
          // Lazy file - store provider function, called on first read
          this.writeFileLazy(path, value);
        } else if (isFileInit(value)) {
          // Extended init with metadata
          this.writeFileSync(path, value.content, undefined, {
            mode: value.mode,
            mtime: value.mtime,
          });
        } else {
          // Simple content
          this.writeFileSync(path, value);
        }
      }
    }
  }

  private checkParentExists(path: string): void {
    const dir = dirname(path);
    if (dir === "/" || dir === ".") return;

    const entry = this.data.get(dir);
    if (!entry || entry.type !== "directory") {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
  }

  // Sync method for writing files
  writeFileSync(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
    metadata?: { mode?: number; mtime?: Date },
  ): void {
    validatePath(path, "write");
    const normalized = normalizePath(path);
    this.checkParentExists(normalized);

    const encoding = getEncoding(options);
    const buffer = toBuffer(content, encoding);

    const isNew = !this.data.has(normalized);
    this.data.set(normalized, {
      type: "file",
      content: buffer,
      mode: metadata?.mode ?? DEFAULT_FILE_MODE,
      mtime: metadata?.mtime ?? new Date(),
    });

    if (isNew) {
      const parent = dirname(normalized);
      const name = normalized.slice(parent === "/" ? 1 : parent.length + 1);
      this.addToChildIndex(parent, name);
    }
  }

  /**
   * Store a lazy file entry whose content is provided by a function on first read.
   * Writing to the path replaces the lazy entry, so the function is never called.
   */
  writeFileLazy(
    path: string,
    lazy: () => string | Uint8Array | Promise<string | Uint8Array>,
    metadata?: { mode?: number; mtime?: Date },
  ): void {
    validatePath(path, "write");
    const normalized = normalizePath(path);
    this.checkParentExists(normalized);

    const isNew = !this.data.has(normalized);
    this.data.set(normalized, {
      type: "file",
      lazy,
      mode: metadata?.mode ?? DEFAULT_FILE_MODE,
      mtime: metadata?.mtime ?? new Date(),
    });

    if (isNew) {
      const parent = dirname(normalized);
      const name = normalized.slice(parent === "/" ? 1 : parent.length + 1);
      this.addToChildIndex(parent, name);
    }
  }

  /**
   * Materialize a lazy file entry, replacing it with a concrete FileEntry.
   * Returns the materialized FileEntry.
   */
  private async materializeLazy(
    path: string,
    entry: LazyFileEntry,
  ): Promise<FileEntry> {
    const content = await entry.lazy();
    const buffer =
      typeof content === "string" ? textEncoder.encode(content) : content;
    const materialized: FileEntry = {
      type: "file",
      content: buffer,
      mode: entry.mode,
      mtime: entry.mtime,
    };
    this.data.set(path, materialized);
    return materialized;
  }

  // Async public API
  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    const buffer = await this.readFileBuffer(path);
    const encoding = getEncoding(options);
    return fromBuffer(buffer, encoding);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    validatePath(path, "open");
    // Resolve all symlinks in the path (including intermediate components)
    const resolvedPath = this.resolvePathWithSymlinks(path);
    const entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    if (entry.type !== "file") {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${path}'`,
      );
    }

    // Materialize lazy files on first read
    if ("lazy" in entry) {
      const materialized = await this.materializeLazy(resolvedPath, entry);
      return materialized.content instanceof Uint8Array
        ? materialized.content
        : textEncoder.encode(materialized.content);
    }

    // Return content as Uint8Array
    if (entry.content instanceof Uint8Array) {
      return entry.content;
    }
    // Legacy string content - convert to Uint8Array
    return textEncoder.encode(entry.content);
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    this.writeFileSync(path, content, options);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    validatePath(path, "append");
    const normalized = normalizePath(path);
    const existing = this.data.get(normalized);

    if (existing && existing.type === "directory") {
      throw new Error(
        `EISDIR: illegal operation on a directory, write '${path}'`,
      );
    }

    const encoding = getEncoding(options);
    const newBuffer = toBuffer(content, encoding);

    if (existing?.type === "file") {
      // Materialize lazy files before appending
      let materialized = existing;
      if ("lazy" in materialized) {
        materialized = await this.materializeLazy(normalized, materialized);
      }

      // Get existing content as buffer
      const existingBuffer =
        "content" in materialized && materialized.content instanceof Uint8Array
          ? materialized.content
          : textEncoder.encode(
              "content" in materialized ? (materialized.content as string) : "",
            );

      // Concatenate buffers
      const combined = new Uint8Array(existingBuffer.length + newBuffer.length);
      combined.set(existingBuffer);
      combined.set(newBuffer, existingBuffer.length);

      this.data.set(normalized, {
        type: "file",
        content: combined,
        mode: materialized.mode,
        mtime: new Date(),
      });
    } else {
      this.writeFileSync(path, content, options);
    }
  }

  async exists(path: string): Promise<boolean> {
    if (path.includes("\0")) {
      return false;
    }
    try {
      const resolvedPath = this.resolvePathWithSymlinks(path);
      return this.data.has(resolvedPath);
    } catch {
      // Path resolution failed (e.g., broken symlink in path)
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    validatePath(path, "stat");
    // Resolve all symlinks in the path (including intermediate components)
    const resolvedPath = this.resolvePathWithSymlinks(path);
    let entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    // Materialize lazy files to get accurate size
    if (entry.type === "file" && "lazy" in entry) {
      entry = await this.materializeLazy(resolvedPath, entry);
    }

    // Calculate size: for files, it's the byte length; for directories, it's 0
    let size = 0;
    if (entry.type === "file" && "content" in entry && entry.content) {
      if (entry.content instanceof Uint8Array) {
        size = entry.content.length;
      } else {
        // Legacy string content - calculate byte length
        size = textEncoder.encode(entry.content).length;
      }
    }

    return {
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: false, // stat follows symlinks, so this is always false
      mode: entry.mode,
      size,
      mtime: entry.mtime || new Date(),
    };
  }

  async lstat(path: string): Promise<FsStat> {
    validatePath(path, "lstat");
    // Resolve intermediate symlinks but NOT the final component
    const resolvedPath = this.resolveIntermediateSymlinks(path);
    let entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
    }

    // For symlinks, return symlink info (don't follow)
    if (entry.type === "symlink") {
      return {
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
        mode: entry.mode,
        size: entry.target.length,
        mtime: entry.mtime || new Date(),
      };
    }

    // Materialize lazy files to get accurate size
    if (entry.type === "file" && "lazy" in entry) {
      entry = await this.materializeLazy(resolvedPath, entry);
    }

    // Calculate size: for files, it's the byte length; for directories, it's 0
    let size = 0;
    if (entry.type === "file" && "content" in entry && entry.content) {
      if (entry.content instanceof Uint8Array) {
        size = entry.content.length;
      } else {
        // Legacy string content - calculate byte length
        size = textEncoder.encode(entry.content).length;
      }
    }

    return {
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: false,
      mode: entry.mode,
      size,
      mtime: entry.mtime || new Date(),
    };
  }

  /**
   * Resolve symlinks in intermediate path components only (not the final component).
   * Used by lstat which should not follow the final symlink.
   */
  private resolveIntermediateSymlinks(path: string): string {
    const normalized = normalizePath(path);
    if (normalized === "/") return "/";

    const parts = normalized.slice(1).split("/");
    if (parts.length <= 1) return normalized; // No intermediate components

    let resolvedPath = "";
    const seen = new Set<string>();

    // Process all but the last component
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      resolvedPath = `${resolvedPath}/${part}`;

      let entry = this.data.get(resolvedPath);
      let loopCount = 0;
      const maxLoops = MAX_SYMLINK_DEPTH;

      while (entry && entry.type === "symlink" && loopCount < maxLoops) {
        if (seen.has(resolvedPath)) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, lstat '${path}'`,
          );
        }
        seen.add(resolvedPath);
        resolvedPath = resolveSymlinkTarget(resolvedPath, entry.target);
        entry = this.data.get(resolvedPath);
        loopCount++;
      }

      if (loopCount >= maxLoops) {
        throw new Error(
          `ELOOP: too many levels of symbolic links, lstat '${path}'`,
        );
      }
    }

    // Append the final component without resolving
    return `${resolvedPath}/${parts[parts.length - 1]}`;
  }

  /**
   * Resolve all symlinks in a path, including intermediate components.
   * For example: /home/user/linkdir/file.txt where linkdir is a symlink to "subdir"
   * would resolve to /home/user/subdir/file.txt
   */
  private resolvePathWithSymlinks(path: string): string {
    const normalized = normalizePath(path);
    if (normalized === "/") return "/";

    const parts = normalized.slice(1).split("/");
    let resolvedPath = "";
    const seen = new Set<string>();

    for (const part of parts) {
      resolvedPath = `${resolvedPath}/${part}`;

      // Check if this path component is a symlink
      let entry = this.data.get(resolvedPath);
      let loopCount = 0;
      const maxLoops = MAX_SYMLINK_DEPTH; // Prevent infinite loops

      while (entry && entry.type === "symlink" && loopCount < maxLoops) {
        if (seen.has(resolvedPath)) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, open '${path}'`,
          );
        }
        seen.add(resolvedPath);

        // Resolve the symlink
        resolvedPath = resolveSymlinkTarget(resolvedPath, entry.target);
        entry = this.data.get(resolvedPath);
        loopCount++;
      }

      if (loopCount >= maxLoops) {
        throw new Error(
          `ELOOP: too many levels of symbolic links, open '${path}'`,
        );
      }
    }

    return resolvedPath;
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.mkdirSync(path, options);
  }

  /**
   * Synchronous version of mkdir
   */
  mkdirSync(path: string, options?: MkdirOptions): void {
    validatePath(path, "mkdir");
    const normalized = normalizePath(path);

    if (this.data.has(normalized)) {
      const entry = this.data.get(normalized);
      if (entry?.type === "file") {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
      if (!options?.recursive) {
        throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
      }
      return;
    }

    const parent = dirname(normalized);
    if (parent !== "/" && !this.data.has(parent)) {
      if (options?.recursive) {
        this.mkdirSync(parent, { recursive: true });
      } else {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
    }

    this.data.set(normalized, {
      type: "directory",
      mode: DEFAULT_DIR_MODE,
      mtime: new Date(),
    });
    this.childIndex.set(normalized, new Set());

    const name = normalized.slice(parent === "/" ? 1 : parent.length + 1);
    this.addToChildIndex(parent, name);
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.readdirWithFileTypes(path);
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    validatePath(path, "scandir");
    let normalized = normalizePath(path);
    let entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    const seen = new Set<string>();
    while (entry && entry.type === "symlink") {
      if (seen.has(normalized)) {
        throw new Error(
          `ELOOP: too many levels of symbolic links, scandir '${path}'`,
        );
      }
      seen.add(normalized);
      normalized = resolveSymlinkTarget(normalized, entry.target);
      entry = this.data.get(normalized);
    }

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    if (entry.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }

    const children = this.childIndex.get(normalized);
    if (!children) {
      return [];
    }

    const results: DirentEntry[] = [];
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    for (const name of children) {
      const childPath = `${prefix}${name}`;
      const childEntry = this.data.get(childPath);
      if (childEntry) {
        results.push({
          name,
          isFile: childEntry.type === "file",
          isDirectory: childEntry.type === "directory",
          isSymbolicLink: childEntry.type === "symlink",
        });
      }
    }

    results.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return results;
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    validatePath(path, "rm");
    const normalized = normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    if (entry.type === "directory") {
      const children = await this.readdir(normalized);
      if (children.length > 0) {
        if (!options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
        }
        for (const child of children) {
          const childPath = joinPath(normalized, child);
          await this.rm(childPath, options);
        }
      }
    }

    this.data.delete(normalized);
    if (entry.type === "directory") {
      this.childIndex.delete(normalized);
    }
    const parent = dirname(normalized);
    const name = normalized.slice(parent === "/" ? 1 : parent.length + 1);
    this.removeFromChildIndex(parent, name);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    validatePath(src, "cp");
    validatePath(dest, "cp");
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    const srcEntry = this.data.get(srcNorm);

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
    }

    if (srcEntry.type === "file") {
      this.checkParentExists(destNorm);
      const isNew = !this.data.has(destNorm);
      if ("content" in srcEntry) {
        const contentCopy =
          srcEntry.content instanceof Uint8Array
            ? new Uint8Array(srcEntry.content)
            : srcEntry.content;
        this.data.set(destNorm, { ...srcEntry, content: contentCopy });
      } else {
        this.data.set(destNorm, { ...srcEntry });
      }
      if (isNew) {
        const parent = dirname(destNorm);
        const name = destNorm.slice(parent === "/" ? 1 : parent.length + 1);
        this.addToChildIndex(parent, name);
      }
    } else if (srcEntry.type === "symlink") {
      this.checkParentExists(destNorm);
      const isNew = !this.data.has(destNorm);
      this.data.set(destNorm, { ...srcEntry });
      if (isNew) {
        const parent = dirname(destNorm);
        const name = destNorm.slice(parent === "/" ? 1 : parent.length + 1);
        this.addToChildIndex(parent, name);
      }
    } else if (srcEntry.type === "directory") {
      if (!options?.recursive) {
        throw new Error(`EISDIR: is a directory, cp '${src}'`);
      }
      await this.mkdir(destNorm, { recursive: true });
      const children = await this.readdir(srcNorm);
      for (const child of children) {
        const srcChild = joinPath(srcNorm, child);
        const destChild = joinPath(destNorm, child);
        await this.cp(srcChild, destChild, options);
      }
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  // Get all paths (useful for debugging/glob)
  getAllPaths(): string[] {
    return Array.from(this.data.keys());
  }

  resolvePath(base: string, path: string): string {
    return resolvePath(base, path);
  }

  // Change file/directory permissions
  async chmod(path: string, mode: number): Promise<void> {
    validatePath(path, "chmod");
    const normalized = normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
    }

    entry.mode = mode;
  }

  // Create a symbolic link
  async symlink(target: string, linkPath: string): Promise<void> {
    validatePath(linkPath, "symlink");
    const normalized = normalizePath(linkPath);

    if (this.data.has(normalized)) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }

    this.checkParentExists(normalized);
    this.data.set(normalized, {
      type: "symlink",
      target,
      mode: SYMLINK_MODE,
      mtime: new Date(),
    });

    const parent = dirname(normalized);
    const name = normalized.slice(parent === "/" ? 1 : parent.length + 1);
    this.addToChildIndex(parent, name);
  }

  // Create a hard link
  async link(existingPath: string, newPath: string): Promise<void> {
    validatePath(existingPath, "link");
    validatePath(newPath, "link");
    const existingNorm = normalizePath(existingPath);
    const newNorm = normalizePath(newPath);

    const entry = this.data.get(existingNorm);
    if (!entry) {
      throw new Error(
        `ENOENT: no such file or directory, link '${existingPath}'`,
      );
    }

    if (entry.type !== "file") {
      throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);
    }

    if (this.data.has(newNorm)) {
      throw new Error(`EEXIST: file already exists, link '${newPath}'`);
    }

    // Materialize lazy files before creating a hard link
    let resolved = entry;
    if ("lazy" in resolved) {
      resolved = await this.materializeLazy(existingNorm, resolved);
    }

    this.checkParentExists(newNorm);
    this.data.set(newNorm, {
      type: "file",
      content: (resolved as FileEntry).content,
      mode: resolved.mode,
      mtime: resolved.mtime,
    });

    const parent = dirname(newNorm);
    const name = newNorm.slice(parent === "/" ? 1 : parent.length + 1);
    this.addToChildIndex(parent, name);
  }

  // Read the target of a symbolic link
  async readlink(path: string): Promise<string> {
    validatePath(path, "readlink");
    const normalized = normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }

    if (entry.type !== "symlink") {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    }

    return entry.target;
  }

  /**
   * Resolve all symlinks in a path to get the canonical physical path.
   * This is equivalent to POSIX realpath().
   */
  async realpath(path: string): Promise<string> {
    validatePath(path, "realpath");
    // resolvePathWithSymlinks already resolves all symlinks
    const resolved = this.resolvePathWithSymlinks(path);

    // Verify the path exists
    if (!this.data.has(resolved)) {
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    }

    return resolved;
  }

  /**
   * Set access and modification times of a file
   * @param path - The file path
   * @param _atime - Access time (ignored, kept for API compatibility)
   * @param mtime - Modification time
   */
  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    validatePath(path, "utimes");
    const normalized = normalizePath(path);
    const resolved = this.resolvePathWithSymlinks(normalized);
    const entry = this.data.get(resolved);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
    }

    // Update mtime on the entry
    entry.mtime = mtime;
  }

  async snapshot(): Promise<FileSystemSnapshot> {
    // Deep copy the data map
    const snapshotData = new Map<string, FsEntry>();
    for (const [path, entry] of this.data.entries()) {
      // Create a shallow copy of the entry
      const entryCopy = { ...entry };

      // For file entries, we need to deep copy the content buffer if it's not lazy
      if (entryCopy.type === "file" && "content" in entryCopy) {
        if (entryCopy.content instanceof Uint8Array) {
          entryCopy.content = new Uint8Array(entryCopy.content);
        }
      }

      snapshotData.set(path, entryCopy);
    }
    return snapshotData as unknown as FileSystemSnapshot;
  }

  async restore(snapshot: FileSystemSnapshot): Promise<void> {
    const data = snapshot as unknown as Map<string, FsEntry>;
    if (!(data instanceof Map)) {
      throw new Error("Invalid snapshot: expected Map");
    }

    this.data.clear();
    for (const [path, entry] of data.entries()) {
      const entryCopy = { ...entry };
      if (entryCopy.type === "file" && "content" in entryCopy) {
        if (entryCopy.content instanceof Uint8Array) {
          entryCopy.content = new Uint8Array(entryCopy.content);
        }
      }
      this.data.set(path, entryCopy);
    }
    this.rebuildChildIndex();
  }
}
