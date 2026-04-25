/**
 * ag-plan command - Manage planning mode and multi-step designs.
 *
 * Subcommands:
 * - enter : Enter plan mode (read-only)
 * - exit : Exit plan mode (back to execute mode)
 * - status : Check current mode
 * - add <step> : Add a step to the current plan
 * - list : List plan steps
 */

import type { Command, CommandContext, ExecResult } from "../../types.js";

const PLAN_FILE = "/.ag-bash/plan.json";

export const agPlanCommand: Command = {
  name: "ag-plan",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    const bash = ctx.bash;
    if (!bash) return { stdout: "", stderr: "Bash instance not found\n", exitCode: 1 };

    const subcommand = args[0];

    if (!subcommand) {
      return {
        stdout: "",
        stderr: "Usage: ag-plan <enter|exit|status|add|list> [args]\n",
        exitCode: 1,
      };
    }

    switch (subcommand) {
      case "enter":
        bash.setMode("plan");
        return { stdout: "Entered plan mode. You are now in read-only mode.\n", stderr: "", exitCode: 0 };

      case "exit":
        bash.setMode("execute");
        return { stdout: "Exited plan mode. You can now make changes to the codebase.\n", stderr: "", exitCode: 0 };

      case "status":
        return { stdout: `Current mode: ${bash.getMode()}\n`, stderr: "", exitCode: 0 };

      case "add": {
        const step = args.slice(1).join(" ");
        if (!step) return { stdout: "", stderr: "Usage: ag-plan add <step_description>\n", exitCode: 1 };

        let plan: string[] = [];
        if (await ctx.fs.exists(PLAN_FILE)) {
          plan = JSON.parse(await ctx.fs.readFile(PLAN_FILE, "utf8"));
        }
        plan.push(step);
        const planDir = "/.ag-bash";
        if (!(await ctx.fs.exists(planDir))) {
          await ctx.fs.mkdir(planDir, { recursive: true });
        }
        await ctx.fs.writeFile(PLAN_FILE, JSON.stringify(plan, null, 2));
        return { stdout: `Added step ${plan.length}: ${step}\n`, stderr: "", exitCode: 0 };
      }

      case "list": {
        if (!(await ctx.fs.exists(PLAN_FILE))) {
          return { stdout: "No active plan found.\n", stderr: "", exitCode: 0 };
        }
        const plan: string[] = JSON.parse(await ctx.fs.readFile(PLAN_FILE, "utf8"));
        let output = "Current Plan:\n";
        plan.forEach((step, i) => {
          output += `${i + 1}. ${step}\n`;
        });
        return { stdout: output, stderr: "", exitCode: 0 };
      }

      default:
        return { stdout: "", stderr: `Unknown subcommand: ${subcommand}\n`, exitCode: 1 };
    }
  },
};
