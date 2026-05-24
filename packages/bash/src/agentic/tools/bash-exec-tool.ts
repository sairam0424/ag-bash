import { z } from "zod";
import type { Bash } from "../../Bash.js";
import { buildTool, type ToolboxTool } from "../Tool.js";

/**
 * Read-only shell commands that do not modify state.
 */
const READ_ONLY_COMMANDS = [
  "ls",
  "cat",
  "grep",
  "find",
  "pwd",
  "printenv",
  "echo",
  "id",
  "whoami",
  "stat",
  "df",
  "du",
  "ls-R",
  "tree",
  "ag-hover",
  "ag-explain",
  "ag-find-symbol",
] as const;

/**
 * Destructive shell commands that modify filesystem state.
 */
const DESTRUCTIVE_COMMANDS = [
  "rm",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "truncate",
  "dd",
  "cp",
] as const;

/**
 * run_command - Execute a shell command in the sandboxed Bash interpreter.
 *
 * NOTE: bash.exec() here refers to the sandboxed virtual Bash interpreter,
 * NOT Node.js child_process.exec(). All execution is contained within the
 * virtual filesystem and controlled environment.
 *
 * Classifies commands as read-only or destructive based on the
 * command name and presence of output redirection operators.
 */
export const BashExecTool: ToolboxTool = buildTool({
  name: "run_command",
  description: "Execute a shell command in the sandbox.",
  parameters: z.object({
    command: z.string().describe("The shell command to execute."),
  }),
  isReadOnly: (args: { command: string }) => {
    const cmd = args.command.trim().split(/\s+/)[0];
    return (
      (READ_ONLY_COMMANDS as readonly string[]).includes(cmd) &&
      !args.command.includes(">") &&
      !args.command.includes("|")
    );
  },
  isDestructive: (args: { command: string }) => {
    const cmd = args.command.trim().split(/\s+/)[0];
    return (
      (DESTRUCTIVE_COMMANDS as readonly string[]).includes(cmd) ||
      args.command.includes(">")
    );
  },
  execute: async (bash: Bash, { command }: { command: string }) => {
    // Sandboxed virtual Bash interpreter execution (not child_process)
    const result = await bash.exec(command); // eslint-disable-line security/detect-child-process
    return result;
  },
});
