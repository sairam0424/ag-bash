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
      parameters: {
        type: string;
        properties: {
          command: {
            type: string;
            description: string;
          };
        };
        required: string[];
      };
      execute: ({ command }: { command: string; }) => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
        error?: undefined;
      } | {
        error: any;
        exitCode: number;
        stdout?: undefined;
        stderr?: undefined;
      }>;
    };
  };
} {
  const { sandbox } = options;

  return {
    tools: {
      bash: {
        description: "Execute a bash command in a secure sandbox with a virtual filesystem. You can use common commands like ls, cat, grep, awk, sed, jq, etc. to explore the environment and process data.",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The bash command to execute (e.g. 'ls -R', 'cat README.md', 'grep -r \"pattern\" .')",
            },
          },
          required: ["command"],
        },
        execute: async ({ command }: { command: string }): Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
          error?: undefined;
        } | {
          error: any;
          exitCode: number;
          stdout?: undefined;
          stderr?: undefined;
        }> => {
          try {
            const result = await sandbox.exec(command);
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            };
          } catch (error: any) {
            return {
              error: error.message,
              exitCode: 1,
            };
          }
        },
      },
    },
  };
}
