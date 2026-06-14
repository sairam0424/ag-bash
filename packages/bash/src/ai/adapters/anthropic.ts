/**
 * Anthropic tool_use adapter.
 *
 * Converts ToolDefinition[] into the format expected by Anthropic's
 * Messages API `tools` parameter (name, description, input_schema).
 */

import type {
  AnthropicToolSet,
  JSONSchema,
  ToolDefinition,
  ToolResult,
} from "../types.js";

/**
 * Transform tool definitions into Anthropic tool_use format.
 */
export function toAnthropic(definitions: ToolDefinition[]): AnthropicToolSet {
  const toolLookup: Map<string, ToolDefinition> = new Map();

  const tools: AnthropicToolSet["tools"] = definitions.map((def) => {
    toolLookup.set(def.name, def);
    return {
      name: def.name,
      description: def.description,
      input_schema: def.inputSchema as JSONSchema,
    };
  });

  const handleToolUse = async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ content: string }> => {
    const def = toolLookup.get(name);
    if (!def) {
      return {
        content: JSON.stringify({
          error: `Unknown tool: ${name}`,
          exitCode: 1,
        }),
      };
    }

    const result: ToolResult = await def.execute(input);
    return { content: JSON.stringify(result) };
  };

  return { tools, handleToolUse };
}
