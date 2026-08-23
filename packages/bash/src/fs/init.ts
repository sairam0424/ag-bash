/**
 * Filesystem Initialization
 *
 * Sets up the default filesystem structure for the bash environment
 * including /dev, /proc, and common directories.
 */

import { formatProcStatus, KERNEL_VERSION } from "../shell-metadata.js";
import type { IFileSystem } from "./interface.js";
import {
  MountableFs,
  type SyncInitSupport,
} from "./mountable-fs/mountable-fs.js";

/** Standard layout this module scaffolds, quoted in the topology error. */
const STANDARD_LAYOUT = "/bin, /usr/bin, /tmp, /home/user, /dev, /proc";

/**
 * Interface for filesystems that support sync initialization
 * (both InMemoryFs and OverlayFs implement these)
 */
interface SyncInitFs {
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  writeFileSync(path: string, content: string | Uint8Array): void;
  writeFileLazy?(
    path: string,
    lazy: () => string | Uint8Array | Promise<string | Uint8Array>,
  ): void;
}

/**
 * Check if filesystem supports sync initialization
 */
function isSyncInitFs(fs: IFileSystem): fs is IFileSystem & SyncInitFs {
  const maybeFs = fs as unknown as Partial<SyncInitFs>;
  return (
    typeof maybeFs.mkdirSync === "function" &&
    typeof maybeFs.writeFileSync === "function"
  );
}

/**
 * Build the actionable error for a MountableFs whose base cannot service the
 * synchronous scaffolding below.
 *
 * Why fail instead of skipping: skipping leaves a shell with no /bin, /tmp or
 * /dev/null, and `Bash.registerCommand()` swallows the resulting stub-write
 * errors, so the gap only surfaces much later as unrelated command failures.
 * Why fail instead of scaffolding asynchronously: `initFilesystem()` runs
 * inside the `Bash` constructor, which cannot await.
 */
function unsupportedBaseError(support: SyncInitSupport): Error {
  return new Error(
    `Unsupported filesystem topology: MountableFs base '${support.baseName}' ` +
      "is pure-async (no synchronous mkdirSync/writeFileSync), so the " +
      `standard layout (${STANDARD_LAYOUT}) cannot be created during ` +
      "construction. Use a sync-capable base (InMemoryFs, OverlayFs or " +
      `CowFs) and mount '${support.baseName}' at a subpath instead, e.g. ` +
      "new MountableFs({ base: new InMemoryFs(), mounts: [{ mountPoint: " +
      '"/work", filesystem: hostFs }] }).',
  );
}

/**
 * Initialize common directories like /home/user and /tmp
 */
function initCommonDirectories(
  fs: SyncInitFs,
  useDefaultLayout: boolean,
): void {
  // Always create /bin for PATH-based command resolution
  fs.mkdirSync("/bin", { recursive: true });
  fs.mkdirSync("/usr/bin", { recursive: true });

  // /tmp is a standard, always-present directory on every real Unix system,
  // so create it unconditionally (matches `bash` where /tmp is always writable).
  fs.mkdirSync("/tmp", { recursive: true });

  // Create layout-specific directories only for the default layout
  if (useDefaultLayout) {
    fs.mkdirSync("/home/user", { recursive: true });
  }
}

/**
 * Initialize /dev with common device files
 */
function initDevFiles(fs: SyncInitFs): void {
  fs.mkdirSync("/dev", { recursive: true });
  fs.writeFileSync("/dev/null", "");
  fs.writeFileSync("/dev/zero", new Uint8Array(0));
  fs.writeFileSync("/dev/stdin", "");
  fs.writeFileSync("/dev/stdout", "");
  fs.writeFileSync("/dev/stderr", "");
}

/**
 * Virtual process info for /proc filesystem initialization.
 */
interface VirtualProcessInfo {
  pid: number;
  ppid: number;
  uid: number;
  gid: number;
}

/**
 * Initialize /proc with virtual process information.
 * Never exposes real host process info.
 */
function initProcFiles(fs: SyncInitFs, processInfo: VirtualProcessInfo): void {
  fs.mkdirSync("/proc/self/fd", { recursive: true });

  // Kernel version (from shared metadata)
  fs.writeFileSync("/proc/version", `${KERNEL_VERSION}\n`);

  // Process info (from shared metadata)
  fs.writeFileSync("/proc/self/exe", "/bin/bash");
  fs.writeFileSync("/proc/self/cmdline", "bash\0");
  fs.writeFileSync("/proc/self/comm", "bash\n");
  if (fs.writeFileLazy) {
    fs.writeFileLazy("/proc/self/status", () => formatProcStatus(processInfo));
  } else {
    fs.writeFileSync("/proc/self/status", formatProcStatus(processInfo));
  }

  // File descriptors
  fs.writeFileSync("/proc/self/fd/0", "/dev/stdin");
  fs.writeFileSync("/proc/self/fd/1", "/dev/stdout");
  fs.writeFileSync("/proc/self/fd/2", "/dev/stderr");
}

/**
 * Initialize the filesystem with standard directories and files
 * Works with both InMemoryFs and OverlayFs (both write to memory)
 */
export function initFilesystem(
  fs: IFileSystem,
  useDefaultLayout: boolean,
  processInfo: VirtualProcessInfo = { pid: 1, ppid: 0, uid: 1000, gid: 1000 },
): void {
  // A MountableFs always exposes mkdirSync/writeFileSync, but they only
  // delegate to whichever filesystem owns the path — so duck-typing the
  // wrapper below would inspect the WRAPPER instead of the effective BASE.
  // Ask the base directly and fail with an actionable message, rather than
  // letting the first mkdirSync blame '/bin' for a topology problem.
  if (fs instanceof MountableFs) {
    const support = fs.inspectSyncInitSupport();
    if (!support.supported) {
      throw unsupportedBaseError(support);
    }
  }

  // Initialize for filesystems that support sync methods (InMemoryFs and OverlayFs)
  if (isSyncInitFs(fs)) {
    initCommonDirectories(fs, useDefaultLayout);
    initDevFiles(fs);
    initProcFiles(fs, processInfo);
  }
}
