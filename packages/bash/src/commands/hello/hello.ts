import type { Command, CommandContext, ExecResult } from "../../types.js";

/**
 * hello command - A friendly greeting from AG Bash
 */
export const helloCommand: Command = {
  name: "hello",
  async execute(args: string[], _ctx: CommandContext): Promise<ExecResult> {
    const name = args.length > 0 ? args.join(" ") : "Agent";
    const output = `Hello, ${name}! Welcome to AG Bash.\nThis is your custom shell environment for agentic tasks.\n`;
    return {
      stdout: output,
      stderr: "",
      exitCode: 0,
    };
  },
};
