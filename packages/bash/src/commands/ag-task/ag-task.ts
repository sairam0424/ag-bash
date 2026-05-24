import type { Command, CommandContext, ExecResult } from "../../types.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agTaskHelp = {
  name: "ag-task",
  summary: "manage background tasks with lifecycle tracking",
  usage: "ag-task <create|list|get|update|stop> [args]",
  options: [
    "  create  <subject> [--desc <description>] [--active-form <text>] [--owner <id>]",
    "  list    [--status <status>] [--owner <id>]",
    "  get     <task-id>",
    "  update  <task-id> --status <status> [--subject <text>] [--desc <text>]",
    "  stop    <task-id>",
    "",
    "  Status: pending, in_progress, completed, failed, blocked",
    "  --help  display this help and exit",
  ],
};

function parseNamedArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

export const agTaskCommand: Command = {
  name: "ag-task",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(agTaskHelp);

    const taskManager = ctx.bash?.services?.taskManager;
    if (!taskManager) {
      return {
        stdout: "",
        stderr: "ag-task: task manager not available\n",
        exitCode: 1,
      };
    }

    const subcommand = args[0] || "list";

    switch (subcommand) {
      case "create": {
        const _subject = args
          .slice(1)
          .filter(
            (a) =>
              a !== "--desc" &&
              a !== "--active-form" &&
              a !== "--owner" &&
              !args[args.indexOf("--desc") + 1]?.includes(a) &&
              !args[args.indexOf("--active-form") + 1]?.includes(a) &&
              !args[args.indexOf("--owner") + 1]?.includes(a),
          )
          .join(" ");

        const positionalArgs: string[] = [];
        for (let i = 1; i < args.length; i++) {
          if (args[i].startsWith("--")) {
            i++;
            continue;
          }
          positionalArgs.push(args[i]);
        }
        const subjectText = positionalArgs.join(" ");

        if (!subjectText) {
          return {
            stdout: "",
            stderr: "ag-task: missing task subject\n",
            exitCode: 1,
          };
        }

        const desc = parseNamedArg(args, "--desc") || subjectText;
        const activeForm = parseNamedArg(args, "--active-form");
        const owner = parseNamedArg(args, "--owner");

        try {
          const task = taskManager.create({
            subject: subjectText,
            description: desc,
            owner,
            activeForm,
          });
          return {
            stdout: `Created task ${task.id}: ${task.subject}\n`,
            stderr: "",
            exitCode: 0,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { stdout: "", stderr: `ag-task: ${msg}\n`, exitCode: 1 };
        }
      }

      case "list": {
        const statusFilter = parseNamedArg(args, "--status") as any;
        const ownerFilter = parseNamedArg(args, "--owner");
        const tasks = taskManager.list({
          status: statusFilter,
          owner: ownerFilter,
        });

        if (tasks.length === 0) {
          return { stdout: "No tasks found.\n", stderr: "", exitCode: 0 };
        }

        const statusIcons: Record<string, string> = Object.assign(Object.create(null), {
          pending: "[ ]",
          in_progress: "[~]",
          completed: "[x]",
          failed: "[!]",
          blocked: "[#]",
        });

        let output = "Tasks:\n";
        for (const t of tasks) {
          const icon = statusIcons[t.status] || "[?]";
          const ownerStr = t.owner ? ` (${t.owner})` : "";
          output += `  ${t.id.padEnd(10)} ${icon} ${t.subject}${ownerStr}\n`;
        }
        return { stdout: output, stderr: "", exitCode: 0 };
      }

      case "get": {
        const id = args[1];
        if (!id) {
          return {
            stdout: "",
            stderr: "Usage: ag-task get <task-id>\n",
            exitCode: 1,
          };
        }
        const task = taskManager.get(id);
        if (!task) {
          return {
            stdout: "",
            stderr: `ag-task: task ${id} not found\n`,
            exitCode: 1,
          };
        }
        let output = `Task: ${task.id}\n`;
        output += `  Subject:     ${task.subject}\n`;
        output += `  Description: ${task.description}\n`;
        output += `  Status:      ${task.status}\n`;
        if (task.owner) output += `  Owner:       ${task.owner}\n`;
        if (task.activeForm) output += `  Active Form: ${task.activeForm}\n`;
        if (task.blockedBy.length > 0)
          output += `  Blocked By:  ${task.blockedBy.join(", ")}\n`;
        if (task.blocks.length > 0)
          output += `  Blocks:      ${task.blocks.join(", ")}\n`;
        return { stdout: output, stderr: "", exitCode: 0 };
      }

      case "update": {
        const id = args[1];
        if (!id) {
          return {
            stdout: "",
            stderr: "Usage: ag-task update <task-id> --status <status>\n",
            exitCode: 1,
          };
        }
        const status = parseNamedArg(args, "--status") as any;
        const newSubject = parseNamedArg(args, "--subject");
        const newDesc = parseNamedArg(args, "--desc");

        try {
          const task = taskManager.update(id, {
            status,
            subject: newSubject,
            description: newDesc,
          });
          return {
            stdout: `Updated task ${task.id}: ${task.status}\n`,
            stderr: "",
            exitCode: 0,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { stdout: "", stderr: `ag-task: ${msg}\n`, exitCode: 1 };
        }
      }

      case "stop": {
        const id = args[1];
        if (!id) {
          return {
            stdout: "",
            stderr: "Usage: ag-task stop <task-id>\n",
            exitCode: 1,
          };
        }
        try {
          taskManager.update(id, { status: "failed" });
          return {
            stdout: `Stopped task ${id}\n`,
            stderr: "",
            exitCode: 0,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { stdout: "", stderr: `ag-task: ${msg}\n`, exitCode: 1 };
        }
      }

      default:
        return {
          stdout: "",
          stderr: `ag-task: unknown subcommand: ${subcommand}\n`,
          exitCode: 1,
        };
    }
  },
};
