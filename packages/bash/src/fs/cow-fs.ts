/**
 * CowFs - Copy-on-Write filesystem wrapper for multi-agent coordination.
 *
 * Wraps any IFileSystem and intercepts writes into a local memory layer.
 * Reads first check the local layer, then fall through to the parent.
 * This enables isolated agent workspaces that can be diffed and merged.
 *
 * Key properties:
 * - Reads delegate to parent if the path has not been locally written
 * - Writes go exclusively to the local layer (never touch parent)
 * - Deletions are tracked via tombstones
 * - The set of modified paths is available for conflict detection
 */

import { fromBuffer, getEncoding, toBuffer } from "./encoding.js";
import type {
  BufferEncoding,
  CpOptions,
  DirentEntry,
  FileContent,
  FileSystemSnapshot,
  FsStat,
  IFileSystem,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WriteFileOptions,
} from "./interface.js";
import { normalizePath, resolvePath } from "./path-utils.js";

interface CowFileEntry {
  type: "file";
  content: Uint8Array;
  mode: number;
  mtime: Date;
}

interface CowDirEntry {
  type: "directory";
  mode: number;
  mtime: Date;
}

interface CowSymlinkEntry {
  type: "symlink";
  target: string;
  mode: number;
  mtime: Date;
}

type CowEntry = CowFileEntry | CowDirEntry | CowSymlinkEntry;

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
const SYMLINK_MODE = 0o120000;

export class CowFs implements IFileSystem {
  private readonly parent: IFileSystem;
  private readonly local: Map<string, CowEntry> = new Map();
  private readonly deleted: Set<string> = new Set();
  private readonly modifiedPaths: Set<string> = new Set();

  constructor(parent: IFileSystem) {
    this.parent = parent;
  }

  /**
   * Returns the set of paths that have been locally modified or created.
   */
  getModifiedPaths(): ReadonlySet<string> {
    return this.modifiedPaths;
  }

  /**
   * Returns the set of paths that have been locally deleted.
   */
  getDeletedPaths(): ReadonlySet<string> {
    return this.deleted;
  }

  /**
   * Returns the parent filesystem for conflict detection.
   */
  getParent(): IFileSystem {
    return this.parent;
  }

  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    const normalized = normalizePath(path);

    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    const localEntry = this.local.get(normalized);
    if (localEntry) {
      if (localEntry.type !== "file") {
        throw new Error(
          `EISDIR: illegal operation on a directory, read '${path}'`,
        );
      }
      const encoding = getEncoding(options);
      return fromBuffer(localEntry.content, encoding);
    }

    return this.parent.readFile(path, options);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);

    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    const localEntry = this.local.get(normalized);
    if (localEntry) {
      if (localEntry.type !== "file") {
        throw new Error(
          `EISDIR: illegal operation on a directory, read '${path}'`,
        );
      }
      return localEntry.content;
    }

    return this.parent.readFileBuffer(path);
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const normalized = normalizePath(path);
    this.ensureParentDirs(normalized);

    const encoding = getEncoding(options);
    const buffer = toBuffer(content, encoding);

    this.local.set(normalized, {
      type: "file",
      content: buffer,
      mode: DEFAULT_FILE_MODE,
      mtime: new Date(),
    });
    this.deleted.delete(normalized);
    this.modifiedPaths.add(normalized);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const normalized = normalizePath(path);
    const encoding = getEncoding(options);
    const newBuffer = toBuffer(content, encoding);

    let existingBuffer: Uint8Array;
    try {
      existingBuffer = await this.readFileBuffer(normalized);
    } catch {
      existingBuffer = new Uint8Array(0);
    }

    const combined = new Uint8Array(existingBuffer.length + newBuffer.length);
    combined.set(existingBuffer);
    combined.set(newBuffer, existingBuffer.length);

    this.ensureParentDirs(normalized);
    this.local.set(normalized, {
      type: "file",
      content: combined,
      mode: DEFAULT_FILE_MODE,
      mtime: new Date(),
    });
    this.deleted.delete(normalized);
    this.modifiedPaths.add(normalized);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);

    if (this.deleted.has(normalized)) {
      return false;
    }

    if (this.local.has(normalized)) {
      return true;
    }

    return this.parent.exists(path);
  }

  async stat(path: string): Promise<FsStat> {
    const normalized = normalizePath(path);

    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    const localEntry = this.local.get(normalized);
    if (localEntry) {
      let size = 0;
      if (localEntry.type === "file") {
        size = localEntry.content.length;
      }
      return {
        isFile: localEntry.type === "file",
        isDirectory: localEntry.type === "directory",
        isSymbolicLink: localEntry.type === "symlink",
        mode: localEntry.mode,
        size,
        mtime: localEntry.mtime,
      };
    }

    return this.parent.stat(path);
  }

  async lstat(path: string): Promise<FsStat> {
    const normalized = normalizePath(path);

    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
    }

    const localEntry = this.local.get(normalized);
    if (localEntry) {
      let size = 0;
      if (localEntry.type === "file") {
        size = localEntry.content.length;
      } else if (localEntry.type === "symlink") {
        size = localEntry.target.length;
      }
      return {
        isFile: localEntry.type === "file",
        isDirectory: localEntry.type === "directory",
        isSymbolicLink: localEntry.type === "symlink",
        mode: localEntry.mode,
        size,
        mtime: localEntry.mtime,
      };
    }

    return this.parent.lstat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizePath(path);

    const localEntry = this.local.get(normalized);
    if (
      localEntry ||
      (!this.deleted.has(normalized) && (await this.parent.exists(path)))
    ) {
      if (!options?.recursive) {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
      return;
    }

    if (options?.recursive) {
      this.ensureParentDirs(normalized);
    }

    this.local.set(normalized, {
      type: "directory",
      mode: DEFAULT_DIR_MODE,
      mtime: new Date(),
    });
    this.deleted.delete(normalized);
    this.modifiedPaths.add(normalized);
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = normalizePath(path);

    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    const entries = new Set<string>();

    // Get entries from parent
    try {
      const parentEntries = await this.parent.readdir(path);
      for (const entry of parentEntries) {
        const childPath =
          normalized === "/" ? `/${entry}` : `${normalized}/${entry}`;
        if (!this.deleted.has(childPath)) {
          entries.add(entry);
        }
      }
    } catch {
      // Parent might not have this directory
    }

    // Overlay local entries
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    for (const localPath of this.local.keys()) {
      if (localPath.startsWith(prefix)) {
        const rest = localPath.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name && !rest.includes("/")) {
          entries.add(name);
        }
      }
    }

    return Array.from(entries).sort();
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const names = await this.readdir(path);
    const normalized = normalizePath(path);

    const results: DirentEntry[] = [];
    for (const name of names) {
      const childPath =
        normalized === "/" ? `/${name}` : `${normalized}/${name}`;
      try {
        const st = await this.lstat(childPath);
        results.push({
          name,
          isFile: st.isFile,
          isDirectory: st.isDirectory,
          isSymbolicLink: st.isSymbolicLink,
        });
      } catch {
        // Skip entries we can't stat
      }
    }

    return results;
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const normalized = normalizePath(path);

    const pathExists = await this.exists(path);
    if (!pathExists) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    if (options?.recursive) {
      // Recursively remove children
      try {
        const children = await this.readdir(path);
        for (const child of children) {
          const childPath =
            normalized === "/" ? `/${child}` : `${normalized}/${child}`;
          await this.rm(childPath, options);
        }
      } catch {
        // Not a directory, that's fine
      }
    }

    this.local.delete(normalized);
    this.deleted.add(normalized);
    this.modifiedPaths.add(normalized);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcStat = await this.stat(src);

    if (srcStat.isFile) {
      const content = await this.readFileBuffer(src);
      await this.writeFile(dest, content);
    } else if (srcStat.isDirectory) {
      if (!options?.recursive) {
        throw new Error(`EISDIR: is a directory, cp '${src}'`);
      }
      await this.mkdir(dest, { recursive: true });
      const children = await this.readdir(src);
      const srcNorm = normalizePath(src);
      const destNorm = normalizePath(dest);
      for (const child of children) {
        const srcChild = srcNorm === "/" ? `/${child}` : `${srcNorm}/${child}`;
        const destChild =
          destNorm === "/" ? `/${child}` : `${destNorm}/${child}`;
        await this.cp(srcChild, destChild, options);
      }
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  resolvePath(base: string, rel: string): string {
    return resolvePath(base, rel);
  }

  getAllPaths(): string[] {
    const paths = new Set<string>();

    // Add all parent paths
    for (const p of this.parent.getAllPaths()) {
      const normalized = normalizePath(p);
      if (!this.deleted.has(normalized)) {
        paths.add(normalized);
      }
    }

    // Add local paths
    for (const p of this.local.keys()) {
      paths.add(p);
    }

    return Array.from(paths);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const normalized = normalizePath(path);

    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
    }

    const localEntry = this.local.get(normalized);
    if (localEntry) {
      localEntry.mode = mode;
      this.modifiedPaths.add(normalized);
      return;
    }

    // Copy from parent and modify
    const content = await this.parent.readFileBuffer(path);
    this.local.set(normalized, {
      type: "file",
      content,
      mode,
      mtime: new Date(),
    });
    this.modifiedPaths.add(normalized);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const normalized = normalizePath(linkPath);

    const pathExists = await this.exists(linkPath);
    if (pathExists) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }

    this.ensureParentDirs(normalized);
    this.local.set(normalized, {
      type: "symlink",
      target,
      mode: SYMLINK_MODE,
      mtime: new Date(),
    });
    this.deleted.delete(normalized);
    this.modifiedPaths.add(normalized);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const content = await this.readFileBuffer(existingPath);
    const normalized = normalizePath(newPath);

    const pathExists = await this.exists(newPath);
    if (pathExists) {
      throw new Error(`EEXIST: file already exists, link '${newPath}'`);
    }

    const stat = await this.stat(existingPath);
    this.ensureParentDirs(normalized);
    this.local.set(normalized, {
      type: "file",
      content,
      mode: stat.mode,
      mtime: new Date(),
    });
    this.deleted.delete(normalized);
    this.modifiedPaths.add(normalized);
  }

  async readlink(path: string): Promise<string> {
    const normalized = normalizePath(path);

    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }

    const localEntry = this.local.get(normalized);
    if (localEntry) {
      if (localEntry.type !== "symlink") {
        throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
      }
      return localEntry.target;
    }

    return this.parent.readlink(path);
  }

  async realpath(path: string): Promise<string> {
    // Simplified: delegate to parent for non-local paths
    const normalized = normalizePath(path);
    if (this.local.has(normalized)) {
      return normalized;
    }
    return this.parent.realpath(path);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const normalized = normalizePath(path);

    if (this.deleted.has(normalized)) {
      throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
    }

    const localEntry = this.local.get(normalized);
    if (localEntry) {
      localEntry.mtime = mtime;
      this.modifiedPaths.add(normalized);
      return;
    }

    // Copy-on-write: bring from parent
    const stat = await this.parent.stat(path);
    if (stat.isFile) {
      const content = await this.parent.readFileBuffer(path);
      this.local.set(normalized, {
        type: "file",
        content,
        mode: stat.mode,
        mtime,
      });
    } else if (stat.isDirectory) {
      this.local.set(normalized, {
        type: "directory",
        mode: stat.mode,
        mtime,
      });
    }
    this.modifiedPaths.add(normalized);
  }

  async snapshot(): Promise<FileSystemSnapshot> {
    const memoryCopy = new Map<string, CowEntry>();
    for (const [path, entry] of this.local.entries()) {
      const entryCopy = { ...entry };
      if (entryCopy.type === "file") {
        entryCopy.content = new Uint8Array(entryCopy.content);
      }
      memoryCopy.set(path, entryCopy);
    }

    return {
      local: memoryCopy,
      deleted: new Set(this.deleted),
      modifiedPaths: new Set(this.modifiedPaths),
    } as unknown as FileSystemSnapshot;
  }

  async restore(snapshot: FileSystemSnapshot): Promise<void> {
    const s = snapshot as unknown as {
      local: Map<string, CowEntry>;
      deleted: Set<string>;
      modifiedPaths: Set<string>;
    };
    if (!s || !(s.local instanceof Map) || !(s.deleted instanceof Set)) {
      throw new Error(
        "Invalid snapshot: expected { local: Map, deleted: Set, modifiedPaths: Set }",
      );
    }

    this.local.clear();
    for (const [path, entry] of s.local.entries()) {
      const entryCopy = { ...entry };
      if (entryCopy.type === "file") {
        entryCopy.content = new Uint8Array(entryCopy.content);
      }
      this.local.set(path, entryCopy);
    }

    this.deleted.clear();
    for (const path of s.deleted) {
      this.deleted.add(path);
    }

    this.modifiedPaths.clear();
    for (const path of s.modifiedPaths) {
      this.modifiedPaths.add(path);
    }
  }

  /**
   * Ensure parent directories exist in the local layer.
   */
  private ensureParentDirs(path: string): void {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += `/${parts[i]}`;
      if (!this.local.has(current)) {
        this.local.set(current, {
          type: "directory",
          mode: DEFAULT_DIR_MODE,
          mtime: new Date(),
        });
      }
      this.deleted.delete(current);
    }
  }
}
