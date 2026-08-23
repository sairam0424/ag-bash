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
 * Value to advertise for `readOnlyHint` when the tool's `isReadOnly`
 * declaration cannot be resolved. `false` means "this tool may write", which is
 * both the MCP spec default and the conservative answer: a client that trusts
 * it treats the tool as a writer.
 */
const UNRESOLVED_READ_ONLY_HINT = false;

/**
 * Value to advertise for `destructiveHint` when the tool's `isDestructive`
 * declaration cannot be resolved. `true` means "this tool may destroy", which
 * is both the MCP spec default and the conservative answer: a client that
 * trusts it asks for confirmation. `false` here would tell clients that an
 * unknown tool is safe to invoke unattended.
 */
const UNRESOLVED_DESTRUCTIVE_HINT = true;

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
   * Resolve a tool's `isReadOnly`/`isDestructive` declaration into an MCP hint.
   *
   * Only a literal boolean is resolvable. A function-valued declaration is
   * argument-dependent, and `listTools()` has no arguments to give it, so it is
   * treated as UNRESOLVABLE rather than probed with a synthetic empty object:
   *
   *  - The answer for empty args describes neither the tool as a whole nor the
   *    call the client is about to make, so it cannot be advertised as either.
   *  - Probing is actively unsafe in both directions. `(args) =>
   *    args.command.startsWith("rm")` throws on `{}`, and `(args) =>
   *    !args.write` returns `true` on `{}` — which would advertise a writing
   *    tool as read-only.
   *
   * Unresolvable and absent declarations both fall back to `unresolved`, which
   * callers must set to the conservative value for that specific hint (see
   * UNRESOLVED_READ_ONLY_HINT / UNRESOLVED_DESTRUCTIVE_HINT — they point in
   * opposite directions).
   */
  private resolveHint(
    value: ((args: never) => boolean) | boolean | undefined,
    unresolved: boolean,
  ): boolean {
    return typeof value === "boolean" ? value : unresolved;
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

      // Resolve annotations from the raw tool metadata. A missing rawTool is
      // just another unresolvable declaration, so it takes the same
      // conservative defaults rather than a hardcoded `false` pair.
      const rawTool = this.bash.toolbox.getTool(name);
      const annotations: McpToolAnnotations = {
        readOnlyHint: this.resolveHint(
          rawTool?.isReadOnly,
          UNRESOLVED_READ_ONLY_HINT,
        ),
        destructiveHint: this.resolveHint(
          rawTool?.isDestructive,
          UNRESOLVED_DESTRUCTIVE_HINT,
        ),
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
