import { z } from "zod";
import type { Bash } from "../Bash.js";
import { agTodoCommand } from "../commands/ag-todo/ag-todo.js";
import { buildTool, type ToolboxTool } from "./Tool.js";

interface TodoArgs {
  operation: "list" | "add" | "update" | "rm";
  task?: string;
  id?: string;
  status?: "pending" | "doing" | "done";
}

const todoParameters: z.ZodType<TodoArgs> = z.object({
  operation: z
    .enum(["list", "add", "update", "rm"])
    .describe("The operation to perform."),
  task: z
    .string()
    .optional()
    .describe("The task description (required for 'add')."),
  id: z
    .string()
    .optional()
    .describe("The todo ID (required for 'update' and 'rm')."),
  status: z
    .enum(["pending", "doing", "done"])
    .optional()
    .describe("The status to set (required for 'update')."),
});

/**
 * ag_todo - Agentic tool for managing project tasks and todos.
 */
export const TodoTool: ToolboxTool<TodoArgs, string> = buildTool({
  name: "ag_todo",
  description:
    "Manage project tasks and todos. Support for listing, adding, updating, and removing tasks.",
  parameters: todoParameters,
  execute: async (bash: Bash, args: TodoArgs) => {
    const cmdArgs: string[] = [args.operation];

    if (args.operation === "add" && args.task) {
      cmdArgs.push(args.task);
    } else if (args.operation === "update") {
      if (args.id && args.status) {
        cmdArgs.push(args.id, args.status);
      } else {
        throw new Error("ID and status are required for 'update' operation.");
      }
    } else if (args.operation === "rm" && args.id) {
      cmdArgs.push(args.id);
    }

    const result = await agTodoCommand.execute(cmdArgs, {
      fs: bash.fs,
      cwd: bash.cwd,
      env: bash.env,
      stdin: "",
      bash,
      // biome-ignore lint/suspicious/noExplicitAny: Internal command context shim — Bash's private `agentic` field blocks structural assignment to CommandContext.bash (BashHost), and bash.env is a Record vs the Map the context expects.
    } as any);

    return result.stdout || result.stderr;
  },
});
