/**
 * Minimal AI agent for exploring codebases
 *
 * This file contains only the agent logic - see shell.ts for the interactive loop.
 * Uses @ag-bash/bash with a ag-bash OverlayFS to provide read access to the real project files.
 */

import * as path from "node:path";
import { streamText, stepCountIs } from "ai";
import { Bash, OverlayFs, createBashTool } from "@ag-bash/bash";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
};

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
  bash.on("tool:start", (data: any) => {
    console.log(`\n${colors.dim}[Tool] Starting: ${colors.reset}${colors.yellow}${data.name}${colors.reset}`);
  });

  bash.on("tool:progress", (data: any) => {
    // Optional: Log progress for long-running tools
    const message = typeof data.progress === "string" ? data.progress : data.progress?.message;
    if (message) {
      console.log(`${colors.dim}[Tool] Progress: ${message}${colors.reset}`);
    }
  });

  bash.on("tool:end", (data: any) => {
    const duration = data.duration ? `${data.duration}ms` : "unknown";
    const status = data.result?.error ? colors.yellow : colors.green;
    console.log(`${colors.dim}[Tool] Completed: ${colors.reset}${status}${data.name}${colors.reset} ${colors.dim}(${duration})${colors.reset}\n`);
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
        model: "anthropic:claude-3-5-sonnet-latest",
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
