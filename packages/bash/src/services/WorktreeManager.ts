/**
 * WorktreeManager - Virtual worktree isolation service.
 *
 * Manages named worktrees under /.ag-bash/worktrees/<name>/, allowing
 * agents to work in isolated directory contexts with independent branches.
 * Each worktree tracks its originating cwd so the user can seamlessly
 * return after exiting.
 *
 * Publishes lifecycle events to SharedStateBus:
 *   worktree:created, worktree:enter, worktree:exit, worktree:deleted
 */

import type { SharedStateBus } from "./SharedStateBus.js";

// ── Types ───────────────────────────────────────────────────────────

export interface Worktree {
  id: string;
  name: string;
  /** Absolute VFS path, e.g. /.ag-bash/worktrees/my-feature/ */
  path: string;
  /** Branch name associated with this worktree */
  branch: string;
  /** The cwd that was active before entering this worktree */
  originalCwd: string;
  createdAt: number;
}

export interface CreateWorktreeOpts {
  name: string;
  branch?: string;
  originalCwd: string;
}

// ── ID generation ───────────────────────────────────────────────────

// ── Constants ───────────────────────────────────────────────────────

const WORKTREE_BASE = "/.ag-bash/worktrees";

// ── Service ─────────────────────────────────────────────────────────

export class WorktreeManager {
  private worktrees: Map<string, Worktree> = new Map();
  private activeWorktree: string | undefined;
  private bus: SharedStateBus | undefined;
  private nextWorktreeId = 1;

  setBus(bus: SharedStateBus): void {
    this.bus = bus;
  }

  /**
   * Create a new worktree under /.ag-bash/worktrees/<name>/.
   *
   * If no branch is specified the default is `worktree/<name>`.
   * Throws if a worktree with the same name already exists.
   */
  createWorktree(opts: CreateWorktreeOpts): Worktree {
    // Check for duplicate name.
    for (const wt of this.worktrees.values()) {
      if (wt.name === opts.name) {
        throw new Error(`worktree "${opts.name}" already exists`);
      }
    }

    const id = `wt_${this.nextWorktreeId++}`;
    const branch = opts.branch ?? `worktree/${opts.name}`;
    const path = `${WORKTREE_BASE}/${opts.name}`;

    const worktree: Worktree = {
      id,
      name: opts.name,
      path,
      branch,
      originalCwd: opts.originalCwd,
      createdAt: Date.now(),
    };

    this.worktrees.set(id, worktree);

    this.bus?.publish("worktree:created", "worktreeManager", { ...worktree });

    return worktree;
  }

  /**
   * Set a worktree as the active one, identified by ID or name.
   *
   * Throws if the worktree does not exist.
   */
  enterWorktree(idOrName: string): Worktree {
    const worktree = this.getWorktree(idOrName);
    if (!worktree) {
      throw new Error(`worktree "${idOrName}" not found`);
    }

    this.activeWorktree = worktree.id;

    this.bus?.publish("worktree:enter", "worktreeManager", { ...worktree });

    return worktree;
  }

  /**
   * Exit the currently active worktree and return its original cwd.
   *
   * Returns null if no worktree is active.
   */
  exitWorktree(): { originalCwd: string } | null {
    if (!this.activeWorktree) {
      return null;
    }

    const worktree = this.worktrees.get(this.activeWorktree);
    if (!worktree) {
      // Defensive: active ID references a deleted worktree.
      this.activeWorktree = undefined;
      return null;
    }

    const { originalCwd } = worktree;
    this.activeWorktree = undefined;

    this.bus?.publish("worktree:exit", "worktreeManager", {
      id: worktree.id,
      name: worktree.name,
      originalCwd,
    });

    return { originalCwd };
  }

  /** Return the currently active worktree, or undefined if none. */
  getActive(): Worktree | undefined {
    if (!this.activeWorktree) return undefined;
    const wt = this.worktrees.get(this.activeWorktree);
    return wt ? { ...wt } : undefined;
  }

  /** Return a defensive copy of all worktrees. */
  listWorktrees(): Worktree[] {
    return Array.from(this.worktrees.values()).map((wt) => ({ ...wt }));
  }

  /**
   * Delete a worktree by ID or name.
   *
   * If the deleted worktree is the active one, the active reference is
   * cleared. Returns true if a worktree was found and removed.
   */
  deleteWorktree(idOrName: string): boolean {
    const worktree = this.getWorktree(idOrName);
    if (!worktree) return false;

    // Clear active reference if deleting the active worktree.
    if (this.activeWorktree === worktree.id) {
      this.activeWorktree = undefined;
    }

    this.worktrees.delete(worktree.id);

    this.bus?.publish("worktree:deleted", "worktreeManager", {
      id: worktree.id,
      name: worktree.name,
    });

    return true;
  }

  /**
   * Find a worktree by its ID or name.
   *
   * Returns a defensive copy or undefined if not found.
   */
  getWorktree(idOrName: string): Worktree | undefined {
    // Try direct ID lookup first.
    const byId = this.worktrees.get(idOrName);
    if (byId) return { ...byId };

    // Fall back to name search.
    for (const wt of this.worktrees.values()) {
      if (wt.name === idOrName) return { ...wt };
    }

    return undefined;
  }
}
