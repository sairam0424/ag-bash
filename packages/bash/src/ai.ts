import { sanitizeErrorMessage } from "./fs/sanitize-error.js";
import type { Bash } from "./Bash.js";

/**
 * Options for creating an AI tool that wraps a Bash sandbox.
 */
export interface CreateBashToolOptions {
  /**
   * The Bash sandbox instance to use for execution.
   */
  sandbox: Bash;

  /**
   * The destination path for the sandbox (currently used for metadata context).
   */
  destination?: string;

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
    // biome-ignore lint/suspicious/noExplicitAny: complex result type dependent on Sandbox output
    result: any;
  }) => void | Promise<void>;
}

/**
 * Creates a tool compatible with the Vercel AI SDK (ToolLoopAgent, etc.)
 * that allows an AI agent to execute bash commands in a secure sandbox.
 *
 * @param options Configuration for the bash tool
 * @returns An object containing the 'bash' tool definition
 */
export function createBashTool(options: CreateBashToolOptions): {
  tools: {
    bash: {
      description: string;
      // biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK compatibility
      inputSchema: any;
      /** @deprecated Use inputSchema */
      // biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK compatibility
      parameters: any;
      // biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK compatibility
      execute: (args: any) => Promise<any>;
    };
  };
} {
  const { sandbox } = options;

  return {
    tools: {
      bash: {
        description: `Execute a bash command in a secure sandbox with a virtual filesystem. You can use common commands like ls, cat, grep, awk, sed, jq, etc. to explore the environment and process data.${
          options.extraInstructions ? `\n\n${options.extraInstructions}` : ""
        }`,
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description:
                "The bash command to execute (e.g. 'ls -R', 'cat README.md', 'grep -r \"pattern\" .')",
            },
          },
          required: ["command"],
        } as const,
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description:
                "The bash command to execute (e.g. 'ls -R', 'cat README.md', 'grep -r \"pattern\" .')",
            },
          },
          required: ["command"],
        } as const,
        // biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK compatibility
        execute: async ({ command }: { command: string }): Promise<any> => {
          try {
            await options.onBeforeBashCall?.({ command });
            const result = await sandbox.exec(command);
            const toolResult = {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            };
            await options.onAfterBashCall?.({ command, result: toolResult });
            return toolResult;
            // biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK compatibility
          } catch (error: any) {
            const errorResult = {
              error: sanitizeErrorMessage(error.message),
              exitCode: 1,
            };
            await options.onAfterBashCall?.({ command, result: errorResult });
            return errorResult;
          }
        },
      },
    },
  };
}
