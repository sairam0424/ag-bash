/**
 * Browser-compatible entry point for ag-bash.
 *
 * Excludes Node.js-specific modules:
 * - OverlayFs (requires node:fs)
 * - ReadWriteFs (requires node:fs)
 * - Sandbox (uses OverlayFs)
 *
 * Note: The gzip/gunzip/zcat commands will fail at runtime in browsers
 * since they use node:zlib. All other commands work.
 */

export type { BashLogger, BashOptions, ExecOptions } from "./Bash.js";
export { Bash } from "./Bash.js";
export type {
  AllCommandName,
  CommandName,
  NetworkCommandName,
} from "./commands/registry.js";
export {
  getCommandNames,
  getNetworkCommandNames,
} from "./commands/registry.js";
export type { CustomCommand, LazyCommand } from "./custom-commands.js";
export { defineCommand } from "./custom-commands.js";
export { InMemoryFs } from "./fs/in-memory-fs/index.js";
export type {
  BufferEncoding,
  CpOptions,
  DirectoryEntry,
  FileContent,
  FileEntry,
  FileInit,
  FileSystemFactory,
  FsEntry,
  FsStat,
  InitialFiles,
  LazyFileEntry,
  LazyFileProvider,
  MkdirOptions,
  RmOptions,
  SymlinkEntry,
} from "./fs/interface.js";
export type { NetworkConfig } from "./network/index.js";
export {
  NetworkAccessDeniedError,
  RedirectNotAllowedError,
  TooManyRedirectsError,
} from "./network/index.js";
// Browser secondary defense (opt-in). The Node.js DefenseInDepthBox is a no-op
// in browsers (no AsyncLocalStorage); call hardenBrowserGlobals() once at
// startup for Node-parity secondary depth. See SECURITY.md.
export type {
  BrowserHardeningOptions,
  BrowserHardeningResult,
} from "./security/browser-hardening.js";
export {
  hardenBrowserGlobals,
  isBrowserHardened,
} from "./security/browser-hardening.js";
export type {
  BashExecResult,
  Command,
  CommandContext,
  ExecResult,
  IFileSystem,
} from "./types.js";
