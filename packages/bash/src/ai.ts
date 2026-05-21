import type { Bash } from "./Bash.js";
import { sanitizeErrorMessage } from "./fs/sanitize-error.js";

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
    [key: string]: any;
  };
} {
  const { sandbox } = options;
  const toolbox = sandbox.toolbox;
  const agenticTools = toolbox.getAgenticTools(sandbox);

  return {
    tools: {
      ...agenticTools,
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
          const startTime = Date.now();
          sandbox.emit("tool:start", { name: "bash", args: { command } });

          const _onProgress = (progress: any) => {
            sandbox.emit("tool:progress", { name: "bash", progress });
          };

          try {
            await options.onBeforeBashCall?.({ command });
            const result = await sandbox.exec(command, {
              // Pass onProgress if exec supports it (it doesn't yet, but we emit the start/end)
            });
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
            // biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK compatibility
          } catch (error: any) {
            const errorResult = {
              error: sanitizeErrorMessage(error.message),
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
      },
    },
  };
}
