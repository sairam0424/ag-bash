import type { Bash } from "@ag-bash/bash";

/**
 * MCP tool annotations per the Model Context Protocol spec.
 */
export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

/**
 * MCP tool descriptor matching the Model Context Protocol tool listing format.
 */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations?: McpToolAnnotations;
}

/**
 * MCP tool result matching the Model Context Protocol tool call response format.
 */
export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Set of low-level tool names that are handled directly by the MCP server.
 * These are excluded from the bridge to avoid duplicates.
 */
const NATIVE_MCP_TOOLS = new Set([
  "run_bash",
  "get_state",
  "snapshot",
  "restore",
  "create_delta",
  "apply_delta",
]);

/**
 * McpToolBridge — Bridges BashToolbox tools to MCP protocol format.
 *
 * Converts the toolbox's Zod-based tool definitions into MCP-compatible
 * JSON Schema descriptors, and routes tool calls through the BashToolbox
 * execution lifecycle (validation, permissions, execution).
 */
export class McpToolBridge {
  private bash: Bash;

  constructor(bash: Bash) {
    this.bash = bash;
  }

  /**
   * Resolve isReadOnly/isDestructive which can be boolean or function.
   * When a function, call with empty args to get the default hint.
   */
  private resolveHint(
    value: ((args: unknown) => boolean) | boolean | undefined,
  ): boolean {
    if (typeof value === "function") {
      try {
        return value(Object.create(null)) ?? false;
      } catch {
        return false;
      }
    }
    return value ?? false;
  }

  /**
   * List all available BashToolbox tools in MCP format.
   * Excludes tools that are natively handled by the MCP server (run_bash, etc.).
   */
  listTools(): McpToolDescriptor[] {
    const agenticTools = this.bash.toolbox.getAgenticTools(this.bash);
    const descriptors: McpToolDescriptor[] = [];

    for (const [name, entry] of Object.entries(agenticTools)) {
      // Skip tools that already exist as native MCP tools
      if (NATIVE_MCP_TOOLS.has(name)) continue;

      // Resolve annotations from the raw tool metadata
      const rawTool = this.bash.toolbox.getTool(name);
      const annotations: McpToolAnnotations = {
        readOnlyHint: rawTool ? this.resolveHint(rawTool.isReadOnly) : false,
        destructiveHint: rawTool
          ? this.resolveHint(rawTool.isDestructive)
          : false,
      };

      descriptors.push({
        name,
        description: entry.description,
        inputSchema: {
          type: "object",
          properties: entry.inputSchema.properties,
          required:
            entry.inputSchema.required.length > 0
              ? entry.inputSchema.required
              : undefined,
        },
        annotations,
      });
    }

    return descriptors;
  }

  /**
   * Execute a BashToolbox tool by name.
   * Routes through the full toolbox lifecycle (validation, permissions, execution).
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    try {
      const result = await this.bash.toolbox.callTool(this.bash, name, args);

      // Format the result as MCP content
      const text =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);

      // Detect error results from the toolbox
      const isError =
        typeof result === "string" &&
        (result.startsWith("Error") ||
          result.startsWith("Validation Error") ||
          result.startsWith("Permission Denied") ||
          result.startsWith("Execution Error"));

      return {
        content: [{ type: "text", text }],
        isError,
      };
    } catch (error: unknown) {
      const raw =
        error instanceof Error ? error.message : "Unknown error occurred";
      const sanitized = raw
        .replace(/\/[\w./-]+/g, "[path]")
        .replace(/[A-Z]:\\[\w\\.-]+/g, "[path]");
      const message =
        sanitized.length > 200 ? `${sanitized.slice(0, 200)}...` : sanitized;
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  /**
   * Check if a tool name is handled by the bridge (vs native MCP tools).
   */
  hasTool(name: string): boolean {
    if (NATIVE_MCP_TOOLS.has(name)) return false;
    return this.bash.toolbox.getTool(name) !== undefined;
  }
}
