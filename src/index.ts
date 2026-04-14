export * from "./types.js";
export { Bash } from "./Bash.js";
export { InMemoryFs as InMemoryFileSystem } from "./fs/in-memory-fs/index.js";
export { initFilesystem } from "./fs/init.js";
export type { IFileSystem } from "./fs/interface.js";

/**
 * Returns the current version of the Ag-Bash library.
 */
export function version(): string {
  return "1.0.0";
}
