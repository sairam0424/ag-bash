/**
 * OpenAI function calling adapter.
 *
 * Converts ToolDefinition[] into the format expected by OpenAI's
 * chat completions API `tools` parameter (type: "function" with parameters).
 */

import type {
  JSONSchema,
  OpenAIToolSet,
  ToolDefinition,
  ToolResult,
} from "../types.js";

/**
 * Transform tool definitions into OpenAI function calling format.
 */
export function toOpenAI(definitions: ToolDefinition[]): OpenAIToolSet {
  const toolLookup: Map<string, ToolDefinition> = new Map();

  const tools: OpenAIToolSet["tools"] = definitions.map((def) => {
    toolLookup.set(def.name, def);
    return {
      type: "function" as const,
      function: {
        name: def.name,
        description: def.description,
        parameters: def.inputSchema as JSONSchema,
      },
    };
  });

  const handleToolCall = async (
    name: string,
    args: string,
  ): Promise<string> => {
    const def = toolLookup.get(name);
    if (!def) {
      return JSON.stringify({ error: `Unknown tool: ${name}`, exitCode: 1 });
    }

    let parsed: Record<string, unknown> = Object.create(null);
    try {
      parsed = Object.assign(Object.create(null), JSON.parse(args));
    } catch {
      return JSON.stringify({
        error: `Invalid JSON arguments for tool: ${name}`,
        exitCode: 1,
      });
    }
    const result: ToolResult = await def.execute(parsed);
    return JSON.stringify(result);
  };

  return { tools, handleToolCall };
}
