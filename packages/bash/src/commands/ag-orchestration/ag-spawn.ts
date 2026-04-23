/**
 * ag-spawn command - Start a sub-agent in the background
 *
 * Usage: ag-spawn <id> <command>
 */

import { AgentManager } from "../../services/AgentManager.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";

export const agSpawn: Command = {
  name: "ag-spawn",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    const id = args[0];
    const command = args.slice(1).join(" ");

    if (!id || !command) {
      return {
        stdout: "",
        stderr: "Usage: ag-spawn <id> <command>\n",
        exitCode: 1,
      };
    }

    if (!ctx.bash) {
      return {
        stdout: "",
        stderr: "Error: Bash reference missing in context\n",
        exitCode: 1,
      };
    }

    try {
      const manager = AgentManager.getInstance();
      await manager.spawn(id, command, ctx.bash);
      return {
        stdout: `Spawned sub-agent ${id} in background.\n`,
        stderr: "",
        exitCode: 0,
      };
    } catch (e: any) {
      return {
        stdout: "",
        stderr: `Spawn failed: ${e.message}\n`,
        exitCode: 1,
      };
    }
  },
};
