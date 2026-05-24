/**
 * AgentConflictError - Thrown when merging agent changes encounters conflicts.
 *
 * Indicates that one or more files modified by a sub-agent were also
 * modified in the parent filesystem since the agent was spawned.
 */
export class AgentConflictError extends Error {
  public readonly conflicts: string[];
  public readonly agentId: string;

  constructor(agentId: string, conflicts: string[]) {
    const paths = conflicts.join(", ");
    super(
      `Agent "${agentId}" has conflicting changes on: ${paths}`,
    );
    this.name = "AgentConflictError";
    this.agentId = agentId;
    this.conflicts = conflicts;
  }
}
