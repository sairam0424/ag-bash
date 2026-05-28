/**
 * ag-wait command - Synchronize with a sub-agent
 *
 * Usage: ag-wait <id>
 */

import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";

export const agWait: Command = {
  name: "ag-wait",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    const id = args[0];

    if (!id) {
      return {
        stdout: "",
        stderr: "Usage: ag-wait <id>\n",
        exitCode: 1,
      };
    }

    if (!ctx.bash) {
      return { stdout: "", stderr: "ag-wait: no bash host available\n", exitCode: 1 };
    }

    try {
      const manager = ctx.bash.services.agentManager;
      const result = await manager.wait(id);

      let output = `Sub-agent ${id} completed with exit code ${result.exitCode}.\n`;
      if (result.stdout) output += `Stdout:\n${result.stdout}\n`;
      if (result.stderr) output += `Stderr:\n${result.stderr}\n`;

      return { stdout: output, stderr: "", exitCode: 0 };
    } catch (e: any) {
      return { stdout: "", stderr: `Wait failed: ${sanitizeErrorMessage(e.message)}\n`, exitCode: 1 };
    }
  },
};
