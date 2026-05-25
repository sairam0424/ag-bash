export type { BashOptions, ExecOptions } from "../Bash.js";
// Re-export core types consumers need in tests
export { Bash } from "../Bash.js";
export { InMemoryFs } from "../fs/in-memory-fs/index.js";
export type { InitialFiles } from "../fs/interface.js";
export type { ExecResult } from "../types.js";
export {
  assertFails,
  assertFileExists,
  assertFileNotExists,
  assertOutput,
  assertStderr,
  assertSuccess,
} from "./assertions.js";
export { createTestBash, type TestBashOptions } from "./createTestBash.js";
export { EMPTY_PROJECT, GIT_REPO, NODE_PROJECT } from "./fixtures.js";
