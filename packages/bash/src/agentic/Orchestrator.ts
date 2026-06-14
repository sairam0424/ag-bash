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
   *
   * When `toolSubset` is provided, the child agent is constrained to an
   * immutable allowlist of tools: every tool whose name is not in the
   * allowlist is removed from the child's toolbox via the typed public
   * `unregisterTool` API. No `as any` cast is used — the allowlist is
   * computed once as a frozen Set and never mutated in place.
   */
  public async spawn(parent: Bash, options: SpawnOptions): Promise<Bash> {
    const agent = new Bash({
      cwd: options.cwd || parent.cwd,
      env: { ...parent.env, ...options.env },
      agentic: {
        nestingDepth: parent.nestingDepth + 1,
      },
    });

    if (options.toolSubset) {
      this.applyToolAllowlist(agent, options.toolSubset);
    }

    this.agents.set(options.name, agent);
    return agent;
  }

  /**
   * Constrains an agent's toolbox to exactly the allowed tool names.
   *
   * The allowlist is captured as an immutable frozen Set and the set of
   * tools to remove is derived as a new array (the source toolbox list is
   * never mutated while iterating). Removal uses the typed public
   * `BashToolbox.unregisterTool` method.
   */
  private applyToolAllowlist(agent: Bash, toolSubset: readonly string[]): void {
    const allowed: ReadonlySet<string> = Object.freeze(new Set(toolSubset));
    const toRemove = agent.toolbox
      .getTools()
      .filter((tool) => !allowed.has(tool.name))
      .map((tool) => tool.name);

    for (const name of toRemove) {
      agent.toolbox.unregisterTool(name);
    }
  }

  public getAgent(name: string): Bash | undefined {
    return this.agents.get(name);
  }

  public listAgents(): string[] {
    return Array.from(this.agents.keys());
  }
}
