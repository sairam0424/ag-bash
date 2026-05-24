/**
 * Test utilities — import from "@ag-bash/bash/testing"
 *
 * Provides filesystem mocks, test parsers, and helpers for writing
 * tests against ag-bash without needing the full engine.
 */

// In-memory filesystem for test fixtures
export { InMemoryFs } from "./fs/in-memory-fs/index.js";

// Overlay filesystem for layered test scenarios
export { OverlayFs, type OverlayFsOptions } from "./fs/overlay-fs/index.js";

// Filesystem interface types needed for custom mocks
export type {
  DirectoryEntry,
  FileContent,
  FileEntry,
  FileInit,
  FsEntry,
  FsStat,
  IFileSystem,
  InitialFiles,
  MkdirOptions,
  RmOptions,
  SymlinkEntry,
} from "./fs/interface.js";

// Test parser utilities
export type {
  BusyBoxTestCase,
  ParsedBusyBoxTestFile,
} from "./test-utils/busybox-test-parser.js";

// Core types needed in test assertions
export type {
  BashExecResult,
  Command,
  CommandContext,
  ExecResult,
  Observation,
} from "./types.js";

// Bash class for creating test sandbox instances
export { Bash } from "./Bash.js";
export type { BashOptions, ExecOptions } from "./Bash.js";
