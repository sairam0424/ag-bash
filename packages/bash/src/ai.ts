/**
 * Backwards-compatible shim for the Vercel AI SDK tool format.
 *
 * The new multi-framework module (`./ai/index.js`) returns a BashToolBuilder.
 * This shim calls `.forVercel()` to preserve the original return shape:
 *   `{ tools: { bash: {...}, ... } }`
 *
 * New consumers should import directly from `./ai/index.js` for access to
 * all framework adapters (.forOpenAI(), .forAnthropic(), .forLangChain(), etc).
 */

import {
  createBashTool as _createBashTool,
  type CreateBashToolOptions,
} from "./ai/index.js";
import type { VercelToolSet } from "./ai/types.js";

/**
 * Extended options that include the legacy `destination` field.
 * New consumers should prefer `CreateBashToolOptions` from `./ai/index.js`.
 */
export interface LegacyCreateBashToolOptions extends CreateBashToolOptions {
  /**
   * The destination path for the sandbox (metadata context, not used at runtime).
   * @deprecated This field is no longer used by the multi-framework module.
   */
  destination?: string;
}

export type { CreateBashToolOptions };

/**
 * Creates a tool compatible with the Vercel AI SDK that lets an AI agent
 * run bash commands inside a sandboxed environment.
 *
 * @param options - Sandbox instance and optional lifecycle hooks.
 * @returns An object with a `tools` map (keys are tool names, including "bash").
 *
 * @example
 * ```ts
 * import { Bash, createBashTool } from "@ag-bash/bash";
 *
 * const bash = new Bash({ files: { "/data.json": '{"ok":true}' } });
 * const { tools } = createBashTool({ sandbox: bash });
 * // Pass `tools` to your Vercel AI SDK agent
 * ```
 */
export function createBashTool(
  options: LegacyCreateBashToolOptions,
): VercelToolSet {
  // `destination` is ignored — kept only for backwards compat
  const { destination: _destination, ...coreOptions } = options;
  return _createBashTool(coreOptions).forVercel();
}
