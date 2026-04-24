import { z } from "zod";
import type { ToolboxTool } from "./BashToolbox.js";
import { Orchestrator } from "./Orchestrator.js";

/**
 * ag_spawn: Spawn a sub-agent to handle a specific task.
 */
export const SpawnTool: ToolboxTool = {
  name: "ag_spawn",
  description: "Spawn a specialized sub-agent to handle a task or sub-project.",
  parameters: z.object({
    name: z.string().describe("Unique name for the sub-agent."),
    instruction: z.string().describe("Initial instruction for the sub-agent."),
    toolSubset: z.array(z.string()).optional().describe("Names of tools allowed for this agent."),
    cwd: z.string().optional().describe("Working directory for the sub-agent."),
  }),
  execute: async (bash, args) => {
    const orchestrator = Orchestrator.getInstance();
    try {
      const subAgent = await orchestrator.spawn(bash, {
        name: args.name,
        toolSubset: args.toolSubset,
        cwd: args.cwd,
      });

      // Execute initial instruction
      const result = await subAgent.exec(args.instruction);
      
      return {
        agent: args.name,
        status: "spawned",
        initialResult: result.stdout || result.stderr || "No output",
      };
    } catch (error: any) {
      return `Spawn failed: ${error.message}`;
    }
  },
};
