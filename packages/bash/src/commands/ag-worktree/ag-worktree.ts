import type { Command, CommandContext, ExecResult } from "../../types.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agWorktreeHelp = {
  name: "ag-worktree",
  summary: "manage isolated virtual worktrees",
  usage: "ag-worktree <enter|exit|list|delete> [args]",
  options: [
    "  enter   <name> [--branch <branch>]  create (if needed) and enter a worktree",
    "  exit                                 leave the active worktree, restore cwd",
    "  list                                 show all worktrees with active indicator",
    "  delete  <name>                       remove a worktree",
    "  --help                               display this help and exit",
  ],
  examples: [
    "ag-worktree enter my-feature",
    "ag-worktree enter hotfix --branch fix/login-bug",
    "ag-worktree list",
    "ag-worktree exit",
    "ag-worktree delete my-feature",
  ],
};

export const agWorktreeCommand: Command = {
  name: "ag-worktree",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(agWorktreeHelp);

    const worktreeManager = ctx.bash?.services?.worktreeManager;
    if (!worktreeManager) {
      return {
        stdout: "",
        stderr: "ag-worktree: worktree manager not available\n",
        exitCode: 1,
      };
    }

    const subcommand = args[0];

    if (!subcommand) {
      return showHelp(agWorktreeHelp);
    }

    switch (subcommand) {
      case "enter": {
        const name = args[1];
        if (!name) {
          return {
            stdout: "",
            stderr: "ag-worktree: missing worktree name\nUsage: ag-worktree enter <name> [--branch <branch>]\n",
            exitCode: 1,
          };
        }

        const branchIdx = args.indexOf("--branch");
        const branch = branchIdx !== -1 ? args[branchIdx + 1] : undefined;

        if (branchIdx !== -1 && !branch) {
          return {
            stdout: "",
            stderr: "ag-worktree: --branch requires a value\n",
            exitCode: 1,
          };
        }

        try {
          // Create the worktree if it does not already exist.
          let worktree = worktreeManager.getWorktree(name);
          if (!worktree) {
            worktree = worktreeManager.createWorktree({
              name,
              branch,
              originalCwd: ctx.cwd,
            });
          }

          // Ensure the worktree directory exists on the VFS.
          await ctx.fs.mkdir(worktree.path, { recursive: true });

          // Enter the worktree (sets it as active).
          worktreeManager.enterWorktree(worktree.id);

          return {
            stdout: `Entered worktree "${worktree.name}" (${worktree.id})\n  path:   ${worktree.path}\n  branch: ${worktree.branch}\n`,
            stderr: "",
            exitCode: 0,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { stdout: "", stderr: `ag-worktree: ${msg}\n`, exitCode: 1 };
        }
      }

      case "exit": {
        try {
          const result = worktreeManager.exitWorktree();
          if (!result) {
            return {
              stdout: "",
              stderr: "ag-worktree: no active worktree to exit\n",
              exitCode: 1,
            };
          }

          return {
            stdout: `Exited worktree. Restored cwd: ${result.originalCwd}\n`,
            stderr: "",
            exitCode: 0,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { stdout: "", stderr: `ag-worktree: ${msg}\n`, exitCode: 1 };
        }
      }

      case "list": {
        const worktrees = worktreeManager.listWorktrees();
        if (worktrees.length === 0) {
          return { stdout: "No worktrees.\n", stderr: "", exitCode: 0 };
        }

        const active = worktreeManager.getActive();
        let output = "Worktrees:\n";
        for (const wt of worktrees) {
          const indicator = active && active.id === wt.id ? " *" : "";
          output += `  ${wt.name} (${wt.id})${indicator}\n`;
          output += `    path:   ${wt.path}\n`;
          output += `    branch: ${wt.branch}\n`;
        }
        return { stdout: output, stderr: "", exitCode: 0 };
      }

      case "delete": {
        const name = args[1];
        if (!name) {
          return {
            stdout: "",
            stderr: "ag-worktree: missing worktree name\nUsage: ag-worktree delete <name>\n",
            exitCode: 1,
          };
        }

        const deleted = worktreeManager.deleteWorktree(name);
        if (!deleted) {
          return {
            stdout: "",
            stderr: `ag-worktree: worktree "${name}" not found\n`,
            exitCode: 1,
          };
        }

        return {
          stdout: `Deleted worktree "${name}"\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      default:
        return {
          stdout: "",
          stderr: `ag-worktree: unknown subcommand: ${subcommand}\n`,
          exitCode: 1,
        };
    }
  },
};
