/**
 * Core execution logic shared by all AI framework adapters.
 *
 * This module extracts the framework-agnostic bash tool execution
 * from the original ai.ts and exposes it as ToolDefinition objects
 * that adapters can reshape into any format.
 */

import type { Bash } from "../Bash.js";
import { sanitizeErrorMessage } from "../fs/sanitize-error.js";
import type { ToolDefinition, ToolExecutionError, ToolResult } from "./types.js";

/**
 * Options for creating a bash tool (shared across all adapters).
 */
export interface CreateBashToolOptions {
  /**
   * The Bash sandbox instance to use for execution.
   */
  sandbox: Bash;

  /**
   * Extra instructions to append to the tool description.
   */
  extraInstructions?: string;

  /**
   * Optional callback called before a bash command is executed.
   */
  onBeforeBashCall?: (input: { command: string }) => void | Promise<void>;

  /**
   * Optional callback called after a bash command is executed.
   */
  onAfterBashCall?: (input: {
    command: string;
    result: ToolResult;
  }) => void | Promise<void>;
}

/**
 * The standard JSON schema for the bash tool's input parameter.
 */
const BASH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "The bash command to run (e.g. 'ls -R', 'cat README.md', 'grep -r \"pattern\" .')",
    },
  },
  required: ["command"],
} as const;

/**
 * Build the core tool definitions from a Bash sandbox.
 *
 * Returns an array of ToolDefinition objects that any adapter can
 * transform into a framework-specific shape.
 */
export function buildToolDefinitions(
  options: CreateBashToolOptions,
): ToolDefinition[] {
  const { sandbox } = options;
  const toolbox = sandbox.toolbox;
  const agenticTools = toolbox.getAgenticTools(sandbox);

  const definitions: ToolDefinition[] = [];

  // Convert agentic tools into ToolDefinition format
  for (const [name, tool] of Object.entries(agenticTools)) {
    if (name === "bash") continue; // We handle bash separately below
    const schema: ToolDefinition["inputSchema"] = (tool.inputSchema as unknown as ToolDefinition["inputSchema"]) ?? {
      type: "object",
      properties: Object.create(null),
    };
    definitions.push({
      name,
      description: tool.description ?? "",
      inputSchema: schema,
      execute: tool.execute as (args: Record<string, unknown>) => Promise<ToolResult>,
    });
  }

  // The primary bash tool
  const bashDescription = `Run a bash command in a secure sandbox with a virtual filesystem. You can use common commands like ls, cat, grep, awk, sed, jq, etc. to explore the environment and process data.${
    options.extraInstructions ? `\n\n${options.extraInstructions}` : ""
  }`;

  definitions.push({
    name: "bash",
    description: bashDescription,
    inputSchema: BASH_INPUT_SCHEMA,
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const command = args.command as string;
      const startTime = Date.now();
      sandbox.emit("tool:start", { name: "bash", args: { command } });

      try {
        await options.onBeforeBashCall?.({ command });
        const result = await sandbox.exec(command);
        const toolResult = {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
        await options.onAfterBashCall?.({ command, result: toolResult });

        sandbox.emit("tool:end", {
          name: "bash",
          result: toolResult,
          duration: Date.now() - startTime,
        });

        return toolResult;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        const errorResult: ToolExecutionError = {
          error: sanitizeErrorMessage(message),
          exitCode: 1,
        };
        await options.onAfterBashCall?.({ command, result: errorResult });

        sandbox.emit("tool:end", {
          name: "bash",
          result: errorResult,
          duration: Date.now() - startTime,
        });

        return errorResult;
      }
    },
  });

  return definitions;
}
