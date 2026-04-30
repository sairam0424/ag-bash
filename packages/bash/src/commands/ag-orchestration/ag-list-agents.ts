/**
 * ag-list-agents command - List all active sub-agents
 *
 * Usage: ag-list-agents
 */

import type { Command, CommandContext, ExecResult } from "../../types.js";

export const agListAgents: Command = {
  name: "ag-list-agents",
  execute: async (
    _args: string[],
    ctx: CommandContext,
  ): Promise<ExecResult> => {
    const manager = ctx.bash.services.agentManager;
    const agents = manager.listAgents();

    if (agents.length === 0) {
      return { stdout: "No sub-agents registered.\n", stderr: "", exitCode: 0 };
    }

    let output = "Active Sub-Agents:\n";
    for (const agent of agents) {
      output += `- ${agent.id}: ${agent.status}\n`;
    }

    return { stdout: output, stderr: "", exitCode: 0 };
  },
};
