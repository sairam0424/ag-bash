import type { Command, CommandContext, ExecResult } from "../../types.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agCronHelp = {
  name: "ag-cron",
  summary: "manage scheduled cron jobs",
  usage: "ag-cron <create|delete|list> [args]",
  options: [
    '  create  <cron-expr> <prompt> [--one-shot] [--durable]',
    "  delete  <job-id>",
    "  list",
    "",
    "  Cron expression: standard 5-field format (minute hour dom month dow)",
    "  Supports: *, ranges (1-5), steps (*/5), lists (1,3,5)",
    "",
    "  --one-shot   fire once then auto-delete (default: recurring)",
    "  --durable    persist job to VFS (default: session-only)",
    "  --help       display this help and exit",
  ],
  examples: [
    'ag-cron create "*/5 * * * *" "echo health check"',
    'ag-cron create "0 9 * * 1-5" "run daily report" --durable',
    'ag-cron create "30 2 * * *" "backup db" --one-shot',
    "ag-cron delete cron_1",
    "ag-cron list",
  ],
};

export const agCronCommand: Command = {
  name: "ag-cron",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(agCronHelp);

    const cronScheduler = ctx.bash?.services?.cronScheduler;
    if (!cronScheduler) {
      return {
        stdout: "",
        stderr: "ag-cron: cron scheduler not available\n",
        exitCode: 1,
      };
    }

    const subcommand = args[0] || "list";

    switch (subcommand) {
      case "create": {
        // Parse: ag-cron create <cron-expr> <prompt> [--one-shot] [--durable]
        // The cron expression is the first positional arg after "create".
        // The prompt is everything else that is not a flag.
        const cronExpr = args[1];
        if (!cronExpr) {
          return {
            stdout: "",
            stderr: "ag-cron: missing cron expression\nUsage: ag-cron create <cron-expr> <prompt> [--one-shot] [--durable]\n",
            exitCode: 1,
          };
        }

        const oneShot = args.includes("--one-shot");
        const durable = args.includes("--durable");

        // Collect prompt from remaining positional args (skip flags)
        const promptParts: string[] = [];
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--one-shot" || args[i] === "--durable") continue;
          promptParts.push(args[i]);
        }
        const prompt = promptParts.join(" ");

        if (!prompt) {
          return {
            stdout: "",
            stderr: "ag-cron: missing prompt\nUsage: ag-cron create <cron-expr> <prompt> [--one-shot] [--durable]\n",
            exitCode: 1,
          };
        }

        try {
          const job = cronScheduler.createJob({
            cron: cronExpr,
            prompt,
            recurring: !oneShot,
            durable,
          });
          const mode = job.recurring ? "recurring" : "one-shot";
          return {
            stdout: `Created ${mode} job ${job.id}: ${job.cron} -> ${job.prompt}\n`,
            stderr: "",
            exitCode: 0,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { stdout: "", stderr: `ag-cron: ${msg}\n`, exitCode: 1 };
        }
      }

      case "delete": {
        const id = args[1];
        if (!id) {
          return {
            stdout: "",
            stderr: "Usage: ag-cron delete <job-id>\n",
            exitCode: 1,
          };
        }
        const deleted = cronScheduler.deleteJob(id);
        if (!deleted) {
          return {
            stdout: "",
            stderr: `ag-cron: job ${id} not found\n`,
            exitCode: 1,
          };
        }
        return {
          stdout: `Deleted job ${id}\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      case "list": {
        const jobs = cronScheduler.listJobs();
        if (jobs.length === 0) {
          return { stdout: "No cron jobs found.\n", stderr: "", exitCode: 0 };
        }

        let output = "Cron jobs:\n";
        for (const job of jobs) {
          const mode = job.recurring ? "recurring" : "one-shot";
          const durability = job.durable ? "durable" : "session";
          const fires = job.fireCount > 0 ? ` (fired ${job.fireCount}x)` : "";
          output += `  ${job.id.padEnd(10)} [${mode}] [${durability}] ${job.cron}  ->  ${job.prompt}${fires}\n`;
        }
        return { stdout: output, stderr: "", exitCode: 0 };
      }

      default:
        return {
          stdout: "",
          stderr: `ag-cron: unknown subcommand: ${subcommand}\n`,
          exitCode: 1,
        };
    }
  },
};
