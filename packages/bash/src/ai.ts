/**
 * Backwards-compatible re-export of createBashTool.
 *
 * The full multi-framework adapter system lives in ./ai/index.ts.
 * This file preserves the original import path for existing consumers.
 */

export { createBashTool, type CreateBashToolOptions } from "./ai/index.js";
