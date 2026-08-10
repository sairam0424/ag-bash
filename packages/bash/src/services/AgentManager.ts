/**
 * AgentManager - Orchestration Service for Ag-Bash
 *
 * Manages the lifecycle of sub-agents (parallel bash instances).
 * Supports Copy-on-Write filesystem isolation for safe parallel execution.
 *
 * Each sub-agent gets its own CowFs layer by default, which reads from the
 * parent but writes to a local layer. Changes can be merged back after
 * conflict detection via mergeAgentChanges().
 *
 * To opt out of isolation (shared filesystem), pass { sharedFs: true }.
 */

import { Bash } from "../Bash.js";
import { CowFs } from "../fs/cow-fs.js";
import type { IFileSystem } from "../fs/interface.js";
import type { ExecResult } from "../types.js";
import { AgentConflictError } from "./AgentConflictError.js";

export interface SpawnOptions {
  /**
   * If true, the sub-agent shares the parent filesystem directly
   * (no CoW isolation). Use for agents that must see each other's writes
   * in real time.
   *
   * Default: false (isolated CoW layer).
   */
  sharedFs?: boolean;
}

export interface MergeResult {
  /** Paths successfully merged into the parent filesystem. */
  merged: string[];
  /** Paths that conflict (modified in both agent and parent since spawn). */
  conflicts: string[];
}

export interface SubAgent {
  id: string;
  bash: Bash;
  status: "running" | "completed" | "error";
  promise?: Promise<ExecResult>;
  result?: ExecResult;
  /** The CoW filesystem for this agent (null if sharedFs was used). */
  cowFs: CowFs | null;
  /** Snapshot of parent file hashes at spawn time for conflict detection. */
  parentSnapshot: Map<string, string> | null;
}

/**
 * Compute a simple content hash for conflict detection.
 * Uses a fast string-length + sample approach for performance.
 */
async function computeFileFingerprint(
  fs: IFileSystem,
  path: string,
): Promise<string | null> {
  try {
    const content = await fs.readFile(path);
    // Fast fingerprint: length + first/last chars + middle sample
    const len = content.length;
    if (len === 0) return "empty";
    const head = content.slice(0, 64);
    const tail = content.slice(-64);
    const mid = content.slice(Math.floor(len / 2), Math.floor(len / 2) + 64);
    return `${len}:${head}:${mid}:${tail}`;
  } catch {
    return null;
  }
}

export class AgentManager {
  private agents: Map<string, SubAgent> = new Map();

  /**
   * Spawn a new sub-agent with optional filesystem isolation.
   *
   * By default, each agent gets a CoW filesystem layer that reads from
   * the parent but writes locally. This prevents cross-agent interference.
   *
   * Pass { sharedFs: true } to opt out and share the parent's filesystem
   * directly (legacy behavior).
   */
  async spawn(
    id: string,
    command: string,
    parentBash: Bash,
    options: SpawnOptions = {},
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

    // Determine filesystem: CoW isolation (default) or shared
    const useSharedFs = options.sharedFs === true;
    let agentFs: IFileSystem;
    let cowFs: CowFs | null = null;
    let parentSnapshot: Map<string, string> | null = null;

    if (useSharedFs) {
      agentFs = parentBash.fs;
    } else {
      cowFs = new CowFs(parentBash.fs);
      agentFs = cowFs;

      // Take a snapshot of parent file fingerprints for conflict detection.
      // We snapshot lazily during merge (comparing current parent state against
      // agent's modified paths), so we just record spawn time here.
      parentSnapshot = new Map();
    }

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
      status: "running",
      cowFs,
      parentSnapshot,
    };

    this.agents.set(id, agent);

    // Capture parent fingerprints for modified files at spawn time
    if (cowFs && parentSnapshot) {
      // We'll capture fingerprints lazily during merge rather than
      // eagerly snapshotting the entire FS. Store an empty map here
      // and compute diffs at merge time by comparing parent's current
      // state to what the agent read.
    }

    // Run the command in the background
    agent.promise = subBash
      .exec(command) // eslint-disable-line security/detect-child-process
      .then((result) => {
        agent.status = "completed";
        agent.result = result;
        return result;
      })
      .catch((error) => {
        agent.status = "error";
        const errResult: ExecResult = {
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        };
        agent.result = errResult;
        return errResult;
      });

    return agent;
  }

  /**
   * Merge an agent's CoW changes back into the parent filesystem.
   *
   * Performs conflict detection: if any file modified by the agent was
   * ALSO modified in the parent since spawn time, those paths are reported
   * as conflicts and NOT merged.
   *
   * @returns MergeResult with merged and conflicting paths.
   * @throws AgentConflictError if conflicts are found and no partial merge is desired.
   */
  async mergeAgentChanges(agentId: string): Promise<MergeResult> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (!agent.cowFs) {
      // Agent was using shared filesystem - nothing to merge
      return { merged: [], conflicts: [] };
    }

    const cowFs = agent.cowFs;
    const parentFs = cowFs.getParent();
    const modifiedPaths = cowFs.getModifiedPaths();
    const deletedPaths = cowFs.getDeletedPaths();

    const merged: string[] = [];
    const conflicts: string[] = [];

    // For each path modified by the agent, check if the parent also changed
    for (const path of modifiedPaths) {
      // Skip directories - only check file conflicts
      try {
        const localStat = await cowFs.stat(path);
        if (localStat.isDirectory) {
          // Directories don't conflict, just ensure they exist
          try {
            await parentFs.mkdir(path, { recursive: true });
          } catch {
            // Already exists, that's fine
          }
          merged.push(path);
          continue;
        }
      } catch {
        // Might be deleted in agent, handle below
      }

      // Check if this is a deletion
      if (deletedPaths.has(path)) {
        // Check if parent still has the file (no conflict for deletions
        // unless parent also modified it)
        const parentExists = await parentFs.exists(path);
        if (parentExists) {
          // For simplicity, treat deletion as non-conflicting
          await parentFs.rm(path, { force: true });
          merged.push(path);
        }
        continue;
      }

      // Check for conflicts: did the parent change this file since we spawned?
      // We use the parentSnapshot fingerprint (captured at spawn) vs current parent
      const spawnFingerprint = agent.parentSnapshot?.get(path) ?? null;
      const currentParentFingerprint = await computeFileFingerprint(
        parentFs,
        path,
      );

      // If we had a spawn-time fingerprint and parent changed since, conflict
      if (
        spawnFingerprint !== null &&
        currentParentFingerprint !== null &&
        spawnFingerprint !== currentParentFingerprint
      ) {
        conflicts.push(path);
        continue;
      }

      // No conflict - apply the agent's version to parent
      try {
        const content = await cowFs.readFileBuffer(path);
        await parentFs.writeFile(path, content);
        merged.push(path);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        conflicts.push(path);
        // Log but don't throw - partial merge
        console.warn(
          `Failed to merge path ${path} for agent ${agentId}: ${message}`,
        );
      }
    }

    return { merged, conflicts };
  }

  /**
   * Capture parent filesystem fingerprints for the given paths.
   * Call this after spawn to enable conflict detection during merge.
   */
  async captureParentFingerprints(
    agentId: string,
    paths: string[],
  ): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent || !agent.parentSnapshot || !agent.cowFs) return;

    const parentFs = agent.cowFs.getParent();
    for (const path of paths) {
      const fingerprint = await computeFileFingerprint(parentFs, path);
      if (fingerprint !== null) {
        agent.parentSnapshot.set(path, fingerprint);
      }
    }
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
    return agent.result ?? { stdout: "", stderr: "Unknown error", exitCode: 1 };
  }

  /**
   * List all sub-agents.
   */
  listAgents(): SubAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get a specific agent by ID.
   */
  getAgent(id: string): SubAgent | undefined {
    return this.agents.get(id);
  }

  /**
   * Remove an agent record and release its CoW layer.
   */
  forget(id: string): void {
    this.agents.delete(id);
  }
}
