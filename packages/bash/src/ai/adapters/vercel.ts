/**
 * Vercel AI SDK adapter.
 *
 * Converts ToolDefinition[] into the format expected by Vercel AI SDK's
 * `tools` parameter (keyed by tool name with inputSchema/parameters/execute).
 */

import type { ToolDefinition, ToolResult, VercelToolSet } from "../types.js";

/**
 * Transform tool definitions into Vercel AI SDK format.
 */
export function toVercel(definitions: ToolDefinition[]): VercelToolSet {
  const tools: VercelToolSet["tools"] = Object.create(null);

  for (const def of definitions) {
    tools[def.name] = {
      description: def.description,
      inputSchema: def.inputSchema,
      parameters: def.inputSchema,
      execute: (args: Record<string, unknown>): Promise<ToolResult> => {
        return def.execute(args);
      },
    };
  }

  return { tools };
}
