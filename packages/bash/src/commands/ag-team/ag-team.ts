import type { Command, CommandContext, ExecResult } from "../../types.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agTeamHelp = {
  name: "ag-team",
  summary: "manage multi-agent teams",
  usage: "ag-team <create|delete|list|add|remove> [args]",
  options: [
    "  create  <name> [--desc <description>]",
    "  delete  <name>",
    "  list",
    "  add     <team-name> <agent-id>",
    "  remove  <team-name> <agent-id>",
    "  --help  display this help and exit",
  ],
};

export const agTeamCommand: Command = {
  name: "ag-team",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(agTeamHelp);

    const teamManager = ctx.bash?.services?.teamManager;
    if (!teamManager) {
      return {
        stdout: "",
        stderr: "ag-team: team manager not available\n",
        exitCode: 1,
      };
    }

    const subcommand = args[0] || "list";

    switch (subcommand) {
      case "create": {
        const name = args[1];
        if (!name) {
          return {
            stdout: "",
            stderr: "ag-team: missing team name\n",
            exitCode: 1,
          };
        }
        const descIdx = args.indexOf("--desc");
        const desc = descIdx !== -1 ? args[descIdx + 1] : undefined;

        try {
          const team = teamManager.createTeam({ name, description: desc });
          return {
            stdout: `Created team ${team.id}: ${team.name}\n`,
            stderr: "",
            exitCode: 0,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { stdout: "", stderr: `ag-team: ${msg}\n`, exitCode: 1 };
        }
      }

      case "delete": {
        const name = args[1];
        if (!name) {
          return {
            stdout: "",
            stderr: "Usage: ag-team delete <name>\n",
            exitCode: 1,
          };
        }
        const deleted = teamManager.deleteTeam(name);
        if (!deleted) {
          return {
            stdout: "",
            stderr: `ag-team: team "${name}" not found\n`,
            exitCode: 1,
          };
        }
        return {
          stdout: `Deleted team ${name}\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      case "list": {
        const teams = teamManager.listTeams();
        if (teams.length === 0) {
          return { stdout: "No teams.\n", stderr: "", exitCode: 0 };
        }
        let output = "Teams:\n";
        for (const t of teams) {
          const agentCount = t.agents.length;
          output += `  ${t.name} (${agentCount} agent${agentCount !== 1 ? "s" : ""})`;
          if (t.description) output += ` — ${t.description}`;
          output += "\n";
        }
        return { stdout: output, stderr: "", exitCode: 0 };
      }

      case "add": {
        const teamName = args[1];
        const agentId = args[2];
        if (!teamName || !agentId) {
          return {
            stdout: "",
            stderr: "Usage: ag-team add <team-name> <agent-id>\n",
            exitCode: 1,
          };
        }
        try {
          teamManager.addAgentToTeam(teamName, agentId);
          return {
            stdout: `Added ${agentId} to team ${teamName}\n`,
            stderr: "",
            exitCode: 0,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { stdout: "", stderr: `ag-team: ${msg}\n`, exitCode: 1 };
        }
      }

      case "remove": {
        const teamName = args[1];
        const agentId = args[2];
        if (!teamName || !agentId) {
          return {
            stdout: "",
            stderr: "Usage: ag-team remove <team-name> <agent-id>\n",
            exitCode: 1,
          };
        }
        try {
          teamManager.removeAgentFromTeam(teamName, agentId);
          return {
            stdout: `Removed ${agentId} from team ${teamName}\n`,
            stderr: "",
            exitCode: 0,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { stdout: "", stderr: `ag-team: ${msg}\n`, exitCode: 1 };
        }
      }

      default:
        return {
          stdout: "",
          stderr: `ag-team: unknown subcommand: ${subcommand}\n`,
          exitCode: 1,
        };
    }
  },
};
