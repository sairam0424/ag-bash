/**
 * AgentManager - Orchestration Service for Ag-Bash
 *
 * Manages the lifecycle of sub-agents (parallel bash instances).
 */

import { Bash } from "../Bash.js";
import { CowFs } from "../fs/cow-fs.js";
import type { IFileSystem } from "../fs/interface.js";
import { AgentConflictError } from "./AgentConflictError.js";
import type { ExecResult } from "../types.js";

export interface SubAgent {
  id: string;
  bash: Bash;
  cowFs: CowFs;
  status: "running" | "completed" | "error";
  promise?: Promise<ExecResult>;
  result?: ExecResult;
}

export class AgentManager {
  private agents: Map<string, SubAgent> = new Map();

  /**
   * Spawn a new sub-agent.
   */
  async spawn(
    id: string,
    command: string,
    parentBash: Bash,
  ): Promise<SubAgent> {
    if (this.agents.has(id)) {
      throw new Error(`Agent with ID ${id} already exists`);
    }

    const limits = parentBash.limits;

    // Enforce maxSubAgents limit
    const activeAgents = Array.from(this.agents.values()).filter(
      (a) => a.status === "running",
    ).length;
    if (activeAgents >= limits.maxSubAgents) {
      throw new Error(
        `Maximum number of sub-agents reached (${limits.maxSubAgents})`,
      );
    }

    // Enforce maxAgentNesting limit
    if (parentBash.nestingDepth >= limits.maxAgentNesting) {
      throw new Error(
        `Maximum agent nesting depth reached (${limits.maxAgentNesting})`,
      );
    }

    // Each sub-agent gets an isolated CoW overlay filesystem
    const agentFs = new CowFs(parentBash.fs);
    const subBash = new Bash({
      fs: agentFs,
      env: parentBash.getEnv(),
      cwd: parentBash.getCwd(),
      agentic: {
        enabled: true,
        nestingDepth: parentBash.nestingDepth + 1,
      },
      executionLimits: limits,
    });

    const agent: SubAgent = {
      id,
      bash: subBash,
      cowFs: agentFs,
      status: "running",
    };

    this.agents.set(id, agent);

    // Run the command in the background
    agent.promise = subBash
      .exec(command)
      .then((result) => {
        agent.status = "completed";
        agent.result = result;
        return result;
      })
      .catch((error) => {
        agent.status = "error";
        const errResult = { stdout: "", stderr: error.message, exitCode: 1 };
        agent.result = errResult;
        return errResult;
      });

    return agent;
  }

  /**
   * Wait for an agent to complete.
   */
  async wait(id: string): Promise<ExecResult> {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Agent ${id} not found`);

    if (agent.promise) {
      return await agent.promise;
    }
    return agent.result || { stdout: "", stderr: "Unknown error", exitCode: 1 };
  }

  /**
   * List all sub-agents.
   */
  listAgents(): SubAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Merge an agent's filesystem changes back into the parent filesystem.
   *
   * Reads each modified path from the agent's CowFs overlay and writes it
   * to the parent filesystem. Paths that fail to merge are reported as conflicts.
   */
  async mergeAgentChanges(
    agentId: string,
  ): Promise<{ merged: string[]; conflicts: string[] }> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const cowFs = agent.cowFs;
    const modifiedPaths = cowFs.getModifiedPaths();

    if (modifiedPaths.size === 0) {
      return { merged: [], conflicts: [] };
    }

    const parentFs: IFileSystem = cowFs.getParent();
    const merged: string[] = [];
    const conflicts: string[] = [];

    for (const path of modifiedPaths) {
      try {
        const content = await cowFs.readFile(path);
        await parentFs.writeFile(path, content);
        merged.push(path);
      } catch {
        conflicts.push(path);
      }
    }

    if (conflicts.length > 0) {
      throw new AgentConflictError(agentId, conflicts);
    }

    return { merged, conflicts };
  }

  /**
   * Remove an agent record.
   */
  forget(id: string): void {
    this.agents.delete(id);
  }
}
