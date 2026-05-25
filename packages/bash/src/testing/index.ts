export { createTestBash, type TestBashOptions } from "./createTestBash.js";
export {
  assertSuccess,
  assertFails,
  assertOutput,
  assertStderr,
  assertFileExists,
  assertFileNotExists,
} from "./assertions.js";
export { EMPTY_PROJECT, NODE_PROJECT, GIT_REPO } from "./fixtures.js";

// Re-export core types consumers need in tests
export { Bash } from "../Bash.js";
export { InMemoryFs } from "../fs/in-memory-fs/index.js";
export type { ExecResult } from "../types.js";
export type { BashOptions, ExecOptions } from "../Bash.js";
export type { InitialFiles } from "../fs/interface.js";
