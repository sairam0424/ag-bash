/**
 * Runtime module behind the `@ag-bash/bash/ai` subpath export.
 *
 * `package.json` splits `./ai` across two modules:
 *   types   -> ./dist/ai/index.d.{ts,cts}  (emitted from `./ai/index.ts`)
 *   runtime -> ./dist/ai.{js,cjs}          (emitted from THIS file)
 *
 * So this file's *value* exports are the contract `./ai/index.ts` declares.
 * They must stay a superset of it, or a consumer gets a TypeScript-clean import
 * that is an ESM link error under `import` and `undefined` under `require`.
 * `./ai/subpath-exports.test.ts` pins that parity — read it before trimming
 * anything here.
 *
 * The one thing this module adds over `./ai/index.ts` is the deprecated
 * `destination` option (see `LegacyCreateBashToolOptions`), which the root
 * `@ag-bash/bash` entry point has always accepted and which existing consumers
 * still pass. Accepting a wider option object than the declarations advertise
 * is the safe direction: nothing a `./ai` consumer can type-check will be
 * rejected at runtime.
 */

import {
  type BashToolBuilder,
  type CreateBashToolOptions,
  createBashTool as createMultiFrameworkBashTool,
} from "./ai/index.js";

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

/**
 * Creates a multi-framework bash tool builder that lets an AI agent run bash
 * commands inside a sandboxed environment.
 *
 * The returned builder also exposes a `.tools` property in Vercel AI SDK shape,
 * so the historic `const { tools } = createBashTool(...)` call site keeps
 * working unchanged.
 *
 * @param options - Sandbox instance and optional lifecycle hooks.
 * @returns A {@link BashToolBuilder} with per-framework conversion methods.
 *
 * @example
 * ```ts
 * import { Bash } from "@ag-bash/bash";
 * import { createBashTool } from "@ag-bash/bash/ai";
 *
 * const bash = new Bash({ files: { "/data.json": '{"ok":true}' } });
 * const builder = createBashTool({ sandbox: bash });
 *
 * const { tools } = builder.forVercel();          // Vercel AI SDK
 * const openai = builder.forOpenAI();             // OpenAI function calling
 * const anthropic = builder.forAnthropic();       // Anthropic tool_use
 * const langchain = builder.forLangChain();       // LangChain
 * ```
 */
export function createBashTool(
  options: LegacyCreateBashToolOptions,
): BashToolBuilder {
  // `destination` is ignored — kept only for backwards compat
  const { destination: _destination, ...coreOptions } = options;
  return createMultiFrameworkBashTool(coreOptions);
}

/*
 * --- Parity with the `./ai` type declarations (dist/ai/index.d.ts) ---
 * Every VALUE `./ai/index.ts` exports has to be reachable here too, because
 * `dist/ai.js` — not `dist/ai/index.js` — is what the `./ai` export map loads
 * at runtime. Every TYPE it exports is re-exported as well, so `dist/ai.d.ts`
 * (the declarations used by the root ".", "./advanced" and "./browser-core"
 * entry points) describes the same surface.
 */
export type {
  AnthropicToolSet,
  BashToolBuilder,
  CreateBashToolOptions,
  GenericToolSet,
  JSONSchema,
  LangChainToolDef,
  LangChainToolSet,
  OpenAIToolSet,
  ToolDefinition,
  ToolExecutionError,
  ToolExecutionResult,
  ToolResult,
  VercelToolSet,
} from "./ai/index.js";
export { toAnthropic, toLangChain, toOpenAI, toVercel } from "./ai/index.js";
