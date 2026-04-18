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
export declare function createBashTool(options: CreateBashToolOptions): {
  tools: {
    bash: {
      description: string;
      inputSchema: any;
      /** @deprecated Use inputSchema */
      parameters: any;
      execute: (args: any) => Promise<any>;
    };
  };
};
