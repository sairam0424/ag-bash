/**
 * TaskManager - Background task lifecycle service.
 *
 * Manages tasks with status tracking, dependency resolution,
 * and SharedStateBus event publishing.
 */

import type { SharedStateBus } from "./SharedStateBus.js";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked";

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner?: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["in_progress", "blocked", "failed"],
  in_progress: ["completed", "failed", "blocked"],
  blocked: ["pending", "in_progress", "failed"],
  completed: [],
  failed: ["pending"],
};

let nextId = 1;

function generateId(): string {
  return `task_${nextId++}`;
}

export class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private bus: SharedStateBus | undefined;
  private maxTasks: number;

  constructor(options?: { maxTasks?: number }) {
    this.maxTasks = options?.maxTasks ?? 100;
  }

  setBus(bus: SharedStateBus): void {
    this.bus = bus;
  }

  create(opts: {
    subject: string;
    description: string;
    owner?: string;
    activeForm?: string;
    metadata?: Record<string, unknown>;
  }): Task {
    if (this.tasks.size >= this.maxTasks) {
      throw new Error(`Maximum task limit reached (${this.maxTasks})`);
    }

    const now = Date.now();
    const task: Task = {
      id: generateId(),
      subject: opts.subject,
      description: opts.description,
      status: "pending",
      owner: opts.owner,
      activeForm: opts.activeForm,
      metadata: opts.metadata,
      blocks: [],
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(task.id, task);
    this.publishChange(task, "created");
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(filter?: { status?: TaskStatus; owner?: string }): Task[] {
    let tasks = Array.from(this.tasks.values());
    if (filter?.status) {
      tasks = tasks.filter((t) => t.status === filter.status);
    }
    if (filter?.owner) {
      tasks = tasks.filter((t) => t.owner === filter.owner);
    }
    return tasks;
  }

  update(
    id: string,
    changes: {
      subject?: string;
      description?: string;
      status?: TaskStatus;
      owner?: string;
      activeForm?: string;
      metadata?: Record<string, unknown>;
      addBlocks?: string[];
      addBlockedBy?: string[];
    },
  ): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);

    if (changes.status && changes.status !== task.status) {
      const allowed = VALID_TRANSITIONS[task.status];
      if (!allowed.includes(changes.status)) {
        throw new Error(
          `Invalid transition: ${task.status} -> ${changes.status}`,
        );
      }
      task.status = changes.status;
    }

    if (changes.subject !== undefined) task.subject = changes.subject;
    if (changes.description !== undefined)
      task.description = changes.description;
    if (changes.owner !== undefined) task.owner = changes.owner;
    if (changes.activeForm !== undefined) task.activeForm = changes.activeForm;
    if (changes.metadata !== undefined) {
      task.metadata = { ...task.metadata, ...changes.metadata };
    }

    if (changes.addBlocks) {
      for (const blockId of changes.addBlocks) {
        if (!task.blocks.includes(blockId)) task.blocks.push(blockId);
        const blocked = this.tasks.get(blockId);
        if (blocked && !blocked.blockedBy.includes(id)) {
          blocked.blockedBy.push(id);
          blocked.updatedAt = Date.now();
        }
      }
    }

    if (changes.addBlockedBy) {
      for (const blockerId of changes.addBlockedBy) {
        if (!task.blockedBy.includes(blockerId))
          task.blockedBy.push(blockerId);
        const blocker = this.tasks.get(blockerId);
        if (blocker && !blocker.blocks.includes(id)) {
          blocker.blocks.push(id);
          blocker.updatedAt = Date.now();
        }
      }
    }

    task.updatedAt = Date.now();
    this.publishChange(task, "updated");

    if (
      task.status === "completed" ||
      task.status === "failed"
    ) {
      this.resolveBlockedTasks(id);
    }

    return task;
  }

  delete(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    for (const blockId of task.blocks) {
      const blocked = this.tasks.get(blockId);
      if (blocked) {
        blocked.blockedBy = blocked.blockedBy.filter((b) => b !== id);
      }
    }

    for (const blockerId of task.blockedBy) {
      const blocker = this.tasks.get(blockerId);
      if (blocker) {
        blocker.blocks = blocker.blocks.filter((b) => b !== id);
      }
    }

    this.tasks.delete(id);
    this.publishChange(task, "deleted");
    return true;
  }

  private resolveBlockedTasks(completedId: string): void {
    for (const task of this.tasks.values()) {
      if (
        task.status === "blocked" &&
        task.blockedBy.includes(completedId)
      ) {
        const allResolved = task.blockedBy.every((bid) => {
          const blocker = this.tasks.get(bid);
          return (
            !blocker ||
            blocker.status === "completed" ||
            blocker.status === "failed"
          );
        });
        if (allResolved) {
          task.status = "pending";
          task.updatedAt = Date.now();
          this.publishChange(task, "unblocked");
        }
      }
    }
  }

  private publishChange(
    task: Task,
    action: "created" | "updated" | "deleted" | "unblocked",
  ): void {
    this.bus?.publish("state:tasks", "taskManager", {
      action,
      task: { ...task },
    });
  }

  toJSON(): Task[] {
    return Array.from(this.tasks.values());
  }

  loadFromJSON(tasks: Task[]): void {
    this.tasks.clear();
    let maxNum = 0;
    for (const task of tasks) {
      this.tasks.set(task.id, task);
      const num = Number.parseInt(task.id.replace("task_", ""), 10);
      if (!Number.isNaN(num) && num > maxNum) maxNum = num;
    }
    nextId = maxNum + 1;
  }
}
