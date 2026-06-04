import { z } from "zod";
import type { Bash } from "../Bash.js";
import { sanitizeErrorMessage } from "../fs/sanitize-error.js";
import type { ToolboxTool } from "./Tool.js";

interface SpawnArgs {
  name: string;
  instruction: string;
  toolSubset?: string[];
  cwd?: string;
}

const spawnParameters: z.ZodType<SpawnArgs> = z.object({
  name: z.string().describe("Unique name for the sub-agent."),
  instruction: z.string().describe("Initial instruction for the sub-agent."),
  toolSubset: z
    .array(z.string())
    .optional()
    .describe("Names of tools allowed for this agent."),
  cwd: z.string().optional().describe("Working directory for the sub-agent."),
});
type SpawnResult =
  | string
  | { agent: string; status: string; initialResult: string };

/**
 * ag_spawn: Spawn a sub-agent to handle a specific task.
 */
export const SpawnTool: ToolboxTool<SpawnArgs, SpawnResult> = {
  name: "ag_spawn",
  description: "Spawn a specialized sub-agent to handle a task or sub-project.",
  parameters: spawnParameters,
  isReadOnly: false,
  isDestructive: false,
  checkPermissions: async (_bash: Bash, _args: SpawnArgs) => ({
    behavior: "allow",
  }),
  validateInput: async (_args: unknown) => ({ result: true }),
  execute: async (bash: Bash, args: SpawnArgs) => {
    const orchestrator = bash.services.orchestrator;
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Spawn failed: ${sanitizeErrorMessage(message)}`;
    }
  },
};
