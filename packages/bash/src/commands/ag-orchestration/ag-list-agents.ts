/**
 * ag-list-agents command - List all active sub-agents
 * 
 * Usage: ag-list-agents
 */

import { Command, CommandContext, ExecResult } from "../../types.js";
import { AgentManager } from "../../services/AgentManager.js";

export const agListAgents: Command = {
  name: "ag-list-agents",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    const manager = AgentManager.getInstance();
    const agents = manager.listAgents();

    if (agents.length === 0) {
      return { stdout: "No sub-agents registered.\n", stderr: "", exitCode: 0 };
    }

    let output = "Active Sub-Agents:\n";
    for (const agent of agents) {
      output += `- ${agent.id}: ${agent.status}\n`;
    }

    return { stdout: output, stderr: "", exitCode: 0 };
  }
};
