/**
 * Slim API surface — import from "@ag-bash/bash/slim"
 *
 * This entry point exports only the ~10 most commonly used symbols,
 * providing a minimal surface for typical AI agent integrations.
 *
 * For the full API, use "@ag-bash/bash" or "@ag-bash/bash/advanced".
 */

// Core class
export { Bash } from "./Bash.js";
export type { BashOptions, ExecOptions } from "./Bash.js";

// AI tool integration
export { createBashTool } from "./ai/index.js";

// Custom command definition
export { defineCommand } from "./custom-commands.js";
export type { CustomCommand } from "./custom-commands.js";

// Filesystem implementations
export { InMemoryFs } from "./fs/in-memory-fs/index.js";
export { OverlayFs } from "./fs/overlay-fs/index.js";
export { ReadWriteFs } from "./fs/read-write-fs/index.js";

// Essential types
export type { ExecResult, Observation } from "./types.js";
