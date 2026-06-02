/**
 * Multi-framework AI tool adapters for ag-bash.
 *
 * The primary entry point is `createBashTool()` which returns a BashToolBuilder.
 * The builder provides method chaining to convert to any supported framework format.
 *
 * @example
 * ```ts
 * import { Bash, createBashTool } from "@ag-bash/bash";
 *
 * const bash = new Bash({ files: { "/data.json": '{"ok":true}' } });
 * const builder = createBashTool({ sandbox: bash });
 *
 * // Vercel AI SDK (default, backwards-compatible)
 * const { tools } = builder.forVercel();
 *
 * // OpenAI function calling
 * const { tools, handleToolCall } = builder.forOpenAI();
 *
 * // Anthropic tool_use
 * const { tools, handleToolUse } = builder.forAnthropic();
 *
 * // LangChain
 * const { tools } = builder.forLangChain();
 * ```
 */

import { toAnthropic } from "./adapters/anthropic.js";
import { toLangChain } from "./adapters/langchain.js";
import { toOpenAI } from "./adapters/openai.js";
import { toVercel } from "./adapters/vercel.js";
import { buildToolDefinitions, type CreateBashToolOptions } from "./core.js";
import type {
  AnthropicToolSet,
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
} from "./types.js";

/**
 * Builder that holds the core tool definitions and provides
 * framework-specific conversion methods.
 */
export interface BashToolBuilder {
  /** Convert to Vercel AI SDK format (keyed tools map). */
  forVercel(): VercelToolSet;
  /** Convert to OpenAI function calling format. */
  forOpenAI(): OpenAIToolSet;
  /** Convert to Anthropic tool_use format. */
  forAnthropic(): AnthropicToolSet;
  /** Convert to LangChain DynamicStructuredTool format. */
  forLangChain(): LangChainToolSet;
  /** Get a framework-agnostic generic format. */
  generic(): GenericToolSet;
  /**
   * Legacy compatibility: accessing `.tools` directly returns Vercel format.
   * @deprecated Use `.forVercel()` instead.
   */
  tools: VercelToolSet["tools"];
}

/**
 * Creates a multi-framework bash tool builder.
 *
 * For backwards compatibility, the returned object also exposes a `.tools`
 * property that returns the Vercel format (matching the original API).
 *
 * @param options - Sandbox instance and optional lifecycle hooks.
 * @returns A BashToolBuilder with framework conversion methods.
 */
export function createBashTool(
  options: CreateBashToolOptions,
): BashToolBuilder {
  const definitions: ToolDefinition[] = buildToolDefinitions(options);

  // Cache adapters lazily to avoid re-computation
  let cachedVercel: VercelToolSet | undefined;
  let cachedOpenAI: OpenAIToolSet | undefined;
  let cachedAnthropic: AnthropicToolSet | undefined;
  let cachedLangChain: LangChainToolSet | undefined;
  let cachedGeneric: GenericToolSet | undefined;

  const builder: BashToolBuilder = {
    forVercel(): VercelToolSet {
      if (!cachedVercel) {
        cachedVercel = toVercel(definitions);
      }
      return cachedVercel;
    },

    forOpenAI(): OpenAIToolSet {
      if (!cachedOpenAI) {
        cachedOpenAI = toOpenAI(definitions);
      }
      return cachedOpenAI;
    },

    forAnthropic(): AnthropicToolSet {
      if (!cachedAnthropic) {
        cachedAnthropic = toAnthropic(definitions);
      }
      return cachedAnthropic;
    },

    forLangChain(): LangChainToolSet {
      if (!cachedLangChain) {
        cachedLangChain = toLangChain(definitions);
      }
      return cachedLangChain;
    },

    generic(): GenericToolSet {
      if (!cachedGeneric) {
        const toolLookup: Map<string, ToolDefinition> = new Map();
        for (const def of definitions) {
          toolLookup.set(def.name, def);
        }

        cachedGeneric = {
          tools: definitions,
          async handleCall(
            name: string,
            args: Record<string, unknown>,
          ): Promise<ToolResult> {
            const def = toolLookup.get(name);
            if (!def) {
              return { error: `Unknown tool: ${name}`, exitCode: 1 };
            }
            return def.execute(args);
          },
        };
      }
      return cachedGeneric;
    },

    // Legacy backwards-compatible `.tools` property
    get tools(): VercelToolSet["tools"] {
      return builder.forVercel().tools;
    },
  };

  return builder;
}

// Re-export types for consumers
export type { CreateBashToolOptions } from "./core.js";
export type {
  AnthropicToolSet,
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
};

// Re-export adapter functions for direct use
export { toAnthropic, toLangChain, toOpenAI, toVercel };
