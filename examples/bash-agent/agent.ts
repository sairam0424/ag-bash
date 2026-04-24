/**
 * Minimal AI agent for exploring codebases
 *
 * This file contains only the agent logic - see shell.ts for the interactive loop.
 * Uses @ag-bash/bash with a ag-bash OverlayFS to provide read access to the real project files.
 */

import * as path from "node:path";
import { streamText, stepCountIs } from "ai";
import { Bash, OverlayFs, createBashTool } from "@ag-bash/bash";

export interface AgentRunner {
  chat(
    message: string,
    callbacks: {
      onText: (text: string) => void;
    }
  ): Promise<void>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CreateAgentOptions {
  /** Directory to explore (defaults to ag-bash project root) */
  rootDir?: string;
  onToolCall?: (command: string) => void;
  onToolResult?: (result: CommandResult) => void;
  onText?: (text: string) => void;
}

/**
 * Creates an agent runner that can explore a codebase
 */
export async function createAgent(
  options: CreateAgentOptions = {}
): Promise<AgentRunner> {
  const projectRoot = options.rootDir
    ? path.resolve(options.rootDir)
    : path.resolve(import.meta.dirname, "../..");

  // Create OverlayFS with the project root directory
  const overlayFs = new OverlayFs({
    root: projectRoot,
    mountPoint: "/workspace",
    readOnly: true,
  });

  // Create Bash instance with the OverlayFS
  const bash = new Bash({
    fs: overlayFs,
    cwd: "/workspace",
  });

  // [NEW in v2.4.0] High-fidelity tool observability
  bash.on("tool:start", (data) => {
    console.log(`\n${colors.dim}[Tool] Starting: ${colors.reset}${colors.yellow}${data.toolName}${colors.reset}`);
  });

  bash.on("tool:progress", (data) => {
    // Optional: Log progress for long-running tools
    if (data.message) {
      console.log(`${colors.dim}[Tool] Progress: ${data.message}${colors.reset}`);
    }
  });

  bash.on("tool:end", (data) => {
    const duration = data.duration ? `${data.duration}ms` : "unknown";
    const status = data.status === "success" ? colors.green : colors.yellow;
    console.log(`${colors.dim}[Tool] Completed: ${colors.reset}${status}${data.toolName}${colors.reset} ${colors.dim}(${duration})${colors.reset}\n`);
  });

  const toolkit = createBashTool({
    sandbox: bash,
    destination: "/workspace",
    extraInstructions: `You have access to files and directories mounted at /workspace.
Use bash commands to explore:
- ls /workspace to see the directory structure
- cat /workspace/filename to read files
- grep -r "pattern" /workspace to search content
- find /workspace -name "*.ext" to find files by pattern
- head, tail, wc, sort, uniq for data analysis

Help the user explore, search, and understand the contents.`,
    onBeforeBashCall: (input: { command: string; }) => {
      options.onToolCall?.(input.command);
      return undefined;
    },
    onAfterBashCall: (input: { result: CommandResult; }) => {
      options.onToolResult?.(input.result);
      return undefined;
    },
  });

  const history: Array<{ role: "user" | "assistant"; content: string }> = [];

  return {
    async chat(message, callbacks) {
      history.push({ role: "user", content: message });

      let fullText = "";

      const result = streamText({
        model: "anthropic/claude-haiku-4.5",
        tools: { bash: toolkit.tools.bash },
        stopWhen: stepCountIs(50),
        messages: history,
      });

      for await (const chunk of result.textStream) {
        options.onText?.(chunk);
        callbacks.onText(chunk);
        fullText += chunk;
      }

      history.push({ role: "assistant", content: fullText });
    },
  };
}
