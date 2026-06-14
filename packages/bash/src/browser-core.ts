/**
 * Minimal browser-compatible entry point for ag-bash.
 *
 * This "core-only" bundle provides the absolute minimum API needed to
 * run bash in a browser for AI agent use cases:
 * - Bash interpreter
 * - InMemoryFs (virtual filesystem)
 * - createBashTool (AI SDK integration)
 *
 * Excludes to minimize bundle size:
 * - isomorphic-git (git commands)
 * - python3/worker, js-exec/worker, sqlite3/worker (WASM runtimes)
 * - LSP modules
 * - Network/curl commands
 * - ag-convert (document intelligence)
 * - OverlayFs, ReadWriteFs, Sandbox (Node.js-specific)
 * - Transform API, Services, Security modules
 */

export type { CreateBashToolOptions } from "./ai.js";
export { createBashTool } from "./ai.js";
export type { BashOptions } from "./Bash.js";
export { Bash } from "./Bash.js";
export { InMemoryFs } from "./fs/in-memory-fs/index.js";
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
export type { ExecResult, Observation } from "./types.js";
