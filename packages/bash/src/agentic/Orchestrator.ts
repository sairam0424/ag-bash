import { Bash } from "../Bash.js";

export interface SpawnOptions {
  name: string;
  toolSubset?: string[]; // Names of tools allowed for this agent
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Orchestrator - Manages sub-agents for parallel or specialized tasks.
 */
export class Orchestrator {
  private agents: Map<string, Bash> = new Map();

  /**
   * Spawns a new sub-agent.
   */
  public async spawn(parent: Bash, options: SpawnOptions): Promise<Bash> {
    const agent = new Bash({
      cwd: options.cwd || parent.cwd,
      env: { ...parent.env, ...options.env },
      agentic: {
        nestingDepth: parent.nestingDepth + 1,
      },
    });

    // If toolSubset is provided, filter the toolbox
    if (options.toolSubset) {
      const allTools = agent.toolbox.getTools();
      for (const tool of allTools) {
        if (!options.toolSubset.includes(tool.name)) {
          // This would require a 'unregisterTool' method in BashToolbox
          (agent.toolbox as any).unregisterTool(tool.name);
        }
      }
    }

    this.agents.set(options.name, agent);
    return agent;
  }

  public getAgent(name: string): Bash | undefined {
    return this.agents.get(name);
  }

  public listAgents(): string[] {
    return Array.from(this.agents.keys());
  }
}
