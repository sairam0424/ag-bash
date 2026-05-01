import type { Command, CommandContext, ExecResult } from "../../types.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agMessageHelp = {
  name: "ag-message",
  summary: "inter-agent messaging",
  usage: "ag-message <send|broadcast|inbox> [args]",
  options: [
    "  send      <from> <to> <message>",
    "  broadcast <from> <team-name> <message>",
    "  inbox     <agent-id>",
    "  --help    display this help and exit",
  ],
};

export const agMessageCommand: Command = {
  name: "ag-message",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(agMessageHelp);

    const teamManager = ctx.bash?.services?.teamManager;
    if (!teamManager) {
      return {
        stdout: "",
        stderr: "ag-message: team manager not available\n",
        exitCode: 1,
      };
    }

    const subcommand = args[0];
    if (!subcommand) {
      return {
        stdout: "",
        stderr: "Usage: ag-message <send|broadcast|inbox> [args]\n",
        exitCode: 1,
      };
    }

    switch (subcommand) {
      case "send": {
        const from = args[1];
        const to = args[2];
        const content = args.slice(3).join(" ");
        if (!from || !to || !content) {
          return {
            stdout: "",
            stderr: "Usage: ag-message send <from> <to> <message>\n",
            exitCode: 1,
          };
        }
        const msg = teamManager.sendMessage(from, to, content);
        return {
          stdout: `Sent ${msg.id}: ${from} -> ${to}\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      case "broadcast": {
        const from = args[1];
        const teamName = args[2];
        const content = args.slice(3).join(" ");
        if (!from || !teamName || !content) {
          return {
            stdout: "",
            stderr:
              "Usage: ag-message broadcast <from> <team-name> <message>\n",
            exitCode: 1,
          };
        }
        try {
          const msgs = teamManager.broadcast(from, teamName, content);
          return {
            stdout: `Broadcast to ${msgs.length} agent(s) in ${teamName}\n`,
            stderr: "",
            exitCode: 0,
          };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            stdout: "",
            stderr: `ag-message: ${msg}\n`,
            exitCode: 1,
          };
        }
      }

      case "inbox": {
        const agentId = args[1];
        if (!agentId) {
          return {
            stdout: "",
            stderr: "Usage: ag-message inbox <agent-id>\n",
            exitCode: 1,
          };
        }
        const messages = teamManager.getInbox(agentId);
        if (messages.length === 0) {
          return {
            stdout: "No messages.\n",
            stderr: "",
            exitCode: 0,
          };
        }
        let output = `Inbox for ${agentId} (${messages.length} message${messages.length !== 1 ? "s" : ""}):\n`;
        for (const m of messages) {
          const time = new Date(m.timestamp).toISOString().slice(11, 19);
          output += `  [${time}] ${m.from}: ${m.content}\n`;
        }
        return { stdout: output, stderr: "", exitCode: 0 };
      }

      default:
        return {
          stdout: "",
          stderr: `ag-message: unknown subcommand: ${subcommand}\n`,
          exitCode: 1,
        };
    }
  },
};
