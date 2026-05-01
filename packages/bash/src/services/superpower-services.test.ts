/**
 * Comprehensive test suite for Phase 1-3 services.
 *
 * Tests all 6 services in isolation — no Bash instance needed.
 * Exercises core methods, edge cases, state transitions, and bounded collections.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { TaskManager, type TaskStatus } from "./TaskManager.js";
import { TeamManager } from "./TeamManager.js";
import { AgentMemory, type MemoryScope } from "./AgentMemory.js";
import { GitTracker } from "./GitTracker.js";
import { CronScheduler, matchesCron } from "./CronScheduler.js";
import { WorktreeManager } from "./WorktreeManager.js";
import { SharedStateBus, type BusEvent } from "./SharedStateBus.js";

/* ================================================================== */
/*  Helper: collect bus events for assertion                           */
/* ================================================================== */

function collectEvents(bus: SharedStateBus, type: string): BusEvent[] {
  const events: BusEvent[] = [];
  bus.subscribe(type, (e) => events.push(e));
  return events;
}

/* ================================================================== */
/*  TaskManager                                                        */
/* ================================================================== */

describe("TaskManager", () => {
  let tm: TaskManager;
  let bus: SharedStateBus;

  beforeEach(() => {
    bus = new SharedStateBus();
    tm = new TaskManager();
    tm.setBus(bus);
  });

  // ── Create ──────────────────────────────────────────────────────

  it("creates a task with default pending status", () => {
    const task = tm.create({
      subject: "Write tests",
      description: "Cover all services",
    });

    expect(task.id).toMatch(/^task_\d+$/);
    expect(task.subject).toBe("Write tests");
    expect(task.description).toBe("Cover all services");
    expect(task.status).toBe("pending");
    expect(task.blocks).toEqual([]);
    expect(task.blockedBy).toEqual([]);
    expect(task.createdAt).toBeGreaterThan(0);
    expect(task.updatedAt).toBe(task.createdAt);
  });

  it("creates a task with optional fields", () => {
    const task = tm.create({
      subject: "Deploy",
      description: "Ship it",
      owner: "alice",
      activeForm: "review",
      metadata: { priority: "high" },
    });

    expect(task.owner).toBe("alice");
    expect(task.activeForm).toBe("review");
    expect(task.metadata).toEqual({ priority: "high" });
  });

  it("publishes a created event on the bus", () => {
    const events = collectEvents(bus, "state:tasks");
    tm.create({ subject: "X", description: "Y" });

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ action: "created" });
  });

  it("generates unique IDs across multiple creates", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      ids.add(tm.create({ subject: `T${i}`, description: "" }).id);
    }
    expect(ids.size).toBe(10);
  });

  // ── Get / List ──────────────────────────────────────────────────

  it("retrieves a task by ID", () => {
    const task = tm.create({ subject: "A", description: "" });
    expect(tm.get(task.id)).toBeDefined();
    expect(tm.get("nonexistent")).toBeUndefined();
  });

  it("lists all tasks and filters by status/owner", () => {
    tm.create({ subject: "A", description: "", owner: "alice" });
    const b = tm.create({ subject: "B", description: "", owner: "bob" });
    tm.update(b.id, { status: "in_progress" });

    expect(tm.list()).toHaveLength(2);
    expect(tm.list({ status: "pending" })).toHaveLength(1);
    expect(tm.list({ owner: "bob" })).toHaveLength(1);
    expect(tm.list({ status: "in_progress", owner: "bob" })).toHaveLength(1);
    expect(tm.list({ status: "completed" })).toHaveLength(0);
  });

  // ── Update & status transitions ─────────────────────────────────

  it("allows valid status transitions", () => {
    const task = tm.create({ subject: "X", description: "" });

    // pending -> in_progress
    tm.update(task.id, { status: "in_progress" });
    expect(tm.get(task.id)!.status).toBe("in_progress");

    // in_progress -> completed
    tm.update(task.id, { status: "completed" });
    expect(tm.get(task.id)!.status).toBe("completed");
  });

  it("rejects invalid status transitions", () => {
    const task = tm.create({ subject: "X", description: "" });

    // pending -> completed is NOT allowed
    expect(() => tm.update(task.id, { status: "completed" })).toThrow(
      "Invalid transition",
    );
  });

  it("rejects transitions from completed (terminal state)", () => {
    const task = tm.create({ subject: "X", description: "" });
    tm.update(task.id, { status: "in_progress" });
    tm.update(task.id, { status: "completed" });

    expect(() => tm.update(task.id, { status: "pending" })).toThrow(
      "Invalid transition",
    );
  });

  it("allows failed -> pending retry", () => {
    const task = tm.create({ subject: "X", description: "" });
    tm.update(task.id, { status: "failed" });
    tm.update(task.id, { status: "pending" });
    expect(tm.get(task.id)!.status).toBe("pending");
  });

  it("merges metadata on update", () => {
    const task = tm.create({
      subject: "X",
      description: "",
      metadata: { a: 1 },
    });
    tm.update(task.id, { metadata: { b: 2 } });
    expect(tm.get(task.id)!.metadata).toEqual({ a: 1, b: 2 });
  });

  it("throws when updating a nonexistent task", () => {
    expect(() => tm.update("bad_id", { subject: "X" })).toThrow("not found");
  });

  // ── Dependency resolution / blocking ────────────────────────────

  it("sets up blocking relationships via addBlocks", () => {
    const a = tm.create({ subject: "A", description: "" });
    const b = tm.create({ subject: "B", description: "" });

    tm.update(a.id, { addBlocks: [b.id] });

    expect(tm.get(a.id)!.blocks).toContain(b.id);
    expect(tm.get(b.id)!.blockedBy).toContain(a.id);
  });

  it("sets up blocking relationships via addBlockedBy", () => {
    const a = tm.create({ subject: "A", description: "" });
    const b = tm.create({ subject: "B", description: "" });

    tm.update(b.id, { addBlockedBy: [a.id] });

    expect(tm.get(b.id)!.blockedBy).toContain(a.id);
    expect(tm.get(a.id)!.blocks).toContain(b.id);
  });

  it("does not duplicate block entries", () => {
    const a = tm.create({ subject: "A", description: "" });
    const b = tm.create({ subject: "B", description: "" });

    tm.update(a.id, { addBlocks: [b.id] });
    tm.update(a.id, { addBlocks: [b.id] }); // duplicate

    expect(tm.get(a.id)!.blocks.filter((x) => x === b.id)).toHaveLength(1);
    expect(tm.get(b.id)!.blockedBy.filter((x) => x === a.id)).toHaveLength(1);
  });

  it("auto-unblocks tasks when all blockers complete", () => {
    const blocker1 = tm.create({ subject: "Blocker1", description: "" });
    const blocker2 = tm.create({ subject: "Blocker2", description: "" });
    const blocked = tm.create({ subject: "Blocked", description: "" });

    // Set up dependencies
    tm.update(blocked.id, { addBlockedBy: [blocker1.id, blocker2.id] });
    tm.update(blocked.id, { status: "blocked" });

    // Complete first blocker — blocked task should remain blocked
    tm.update(blocker1.id, { status: "in_progress" });
    tm.update(blocker1.id, { status: "completed" });
    expect(tm.get(blocked.id)!.status).toBe("blocked");

    // Complete second blocker — blocked task should auto-unblock to pending
    tm.update(blocker2.id, { status: "in_progress" });
    tm.update(blocker2.id, { status: "completed" });
    expect(tm.get(blocked.id)!.status).toBe("pending");
  });

  it("auto-unblocks when a blocker fails (not just completes)", () => {
    const blocker = tm.create({ subject: "Blocker", description: "" });
    const blocked = tm.create({ subject: "Blocked", description: "" });

    tm.update(blocked.id, { addBlockedBy: [blocker.id] });
    tm.update(blocked.id, { status: "blocked" });

    tm.update(blocker.id, { status: "failed" });
    expect(tm.get(blocked.id)!.status).toBe("pending");
  });

  // ── Delete & cleanup ────────────────────────────────────────────

  it("deletes a task and cleans up references", () => {
    const a = tm.create({ subject: "A", description: "" });
    const b = tm.create({ subject: "B", description: "" });

    tm.update(a.id, { addBlocks: [b.id] });
    tm.delete(a.id);

    expect(tm.get(a.id)).toBeUndefined();
    expect(tm.get(b.id)!.blockedBy).not.toContain(a.id);
  });

  it("returns false when deleting a nonexistent task", () => {
    expect(tm.delete("nonexistent")).toBe(false);
  });

  it("publishes a deleted event", () => {
    const events = collectEvents(bus, "state:tasks");
    const task = tm.create({ subject: "X", description: "" });
    events.length = 0; // clear creation event
    tm.delete(task.id);

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ action: "deleted" });
  });

  // ── Max limit ───────────────────────────────────────────────────

  it("enforces maximum task limit", () => {
    const limited = new TaskManager({ maxTasks: 3 });
    limited.setBus(bus);

    limited.create({ subject: "1", description: "" });
    limited.create({ subject: "2", description: "" });
    limited.create({ subject: "3", description: "" });

    expect(() => limited.create({ subject: "4", description: "" })).toThrow(
      "Maximum task limit",
    );
  });

  // ── Serialization ──────────────────────────────────────────────

  it("round-trips via toJSON / loadFromJSON", () => {
    const a = tm.create({ subject: "A", description: "desc" });
    const json = tm.toJSON();

    const tm2 = new TaskManager();
    tm2.loadFromJSON(json);

    expect(tm2.get(a.id)).toBeDefined();
    expect(tm2.get(a.id)!.subject).toBe("A");
  });
});

/* ================================================================== */
/*  TeamManager                                                        */
/* ================================================================== */

describe("TeamManager", () => {
  let tm: TeamManager;
  let bus: SharedStateBus;

  beforeEach(() => {
    bus = new SharedStateBus();
    tm = new TeamManager();
    tm.setBus(bus);
  });

  // ── Create team ─────────────────────────────────────────────────

  it("creates a team with generated ID", () => {
    const team = tm.createTeam({ name: "frontend" });

    expect(team.id).toMatch(/^team_\d+$/);
    expect(team.name).toBe("frontend");
    expect(team.agents).toEqual([]);
    expect(team.createdAt).toBeGreaterThan(0);
  });

  it("creates a team with initial agents", () => {
    const team = tm.createTeam({
      name: "backend",
      agents: ["a1", "a2"],
      description: "The backend crew",
    });

    expect(team.agents).toEqual(["a1", "a2"]);
    expect(team.description).toBe("The backend crew");
  });

  it("publishes created event", () => {
    const events = collectEvents(bus, "state:teams");
    tm.createTeam({ name: "x" });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ action: "created" });
  });

  // ── Duplicate name ──────────────────────────────────────────────

  it("rejects duplicate team names", () => {
    tm.createTeam({ name: "alpha" });
    expect(() => tm.createTeam({ name: "alpha" })).toThrow("already exists");
  });

  // ── Max limit ───────────────────────────────────────────────────

  it("enforces maximum team limit", () => {
    const limited = new TeamManager({ maxTeams: 2 });
    limited.setBus(bus);

    limited.createTeam({ name: "A" });
    limited.createTeam({ name: "B" });

    expect(() => limited.createTeam({ name: "C" })).toThrow(
      "Maximum team limit",
    );
  });

  // ── Get / List / Delete ─────────────────────────────────────────

  it("retrieves a team by ID or name", () => {
    const team = tm.createTeam({ name: "ops" });

    expect(tm.getTeam(team.id)).toBeDefined();
    expect(tm.getTeam("ops")).toBeDefined();
    expect(tm.getTeam("nonexistent")).toBeUndefined();
  });

  it("lists all teams", () => {
    tm.createTeam({ name: "A" });
    tm.createTeam({ name: "B" });
    expect(tm.listTeams()).toHaveLength(2);
  });

  it("deletes a team by name or ID", () => {
    const team = tm.createTeam({ name: "disposable" });
    expect(tm.deleteTeam("disposable")).toBe(true);
    expect(tm.getTeam(team.id)).toBeUndefined();
  });

  it("returns false when deleting a nonexistent team", () => {
    expect(tm.deleteTeam("phantom")).toBe(false);
  });

  // ── Agent management ────────────────────────────────────────────

  it("adds and removes agents from a team", () => {
    const team = tm.createTeam({ name: "squad" });

    tm.addAgentToTeam("squad", "agent-1");
    tm.addAgentToTeam("squad", "agent-2");
    expect(tm.getTeam(team.id)!.agents).toContain("agent-1");
    expect(tm.getTeam(team.id)!.agents).toContain("agent-2");

    // Adding duplicate should be idempotent
    tm.addAgentToTeam("squad", "agent-1");
    expect(
      tm.getTeam(team.id)!.agents.filter((a) => a === "agent-1"),
    ).toHaveLength(1);

    tm.removeAgentFromTeam("squad", "agent-1");
    expect(tm.getTeam(team.id)!.agents).not.toContain("agent-1");
  });

  it("throws when adding agent to nonexistent team", () => {
    expect(() => tm.addAgentToTeam("ghost", "a1")).toThrow("not found");
  });

  it("throws when removing agent from nonexistent team", () => {
    expect(() => tm.removeAgentFromTeam("ghost", "a1")).toThrow("not found");
  });

  // ── Messaging ───────────────────────────────────────────────────

  it("sends a message and retrieves inbox", () => {
    const msg = tm.sendMessage("alice", "bob", "Hello!");

    expect(msg.id).toMatch(/^msg_\d+$/);
    expect(msg.from).toBe("alice");
    expect(msg.to).toBe("bob");
    expect(msg.content).toBe("Hello!");

    const inbox = tm.getInbox("bob");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].content).toBe("Hello!");
  });

  it("publishes message event on the bus", () => {
    const events = collectEvents(bus, "agent:message");
    tm.sendMessage("alice", "bob", "Hi");
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("alice");
  });

  it("retrieves a conversation between two agents", () => {
    tm.sendMessage("alice", "bob", "Hey");
    tm.sendMessage("bob", "alice", "Yo");
    tm.sendMessage("alice", "charlie", "Unrelated");

    const convo = tm.getConversation("alice", "bob");
    expect(convo).toHaveLength(2);
  });

  // ── Broadcast ───────────────────────────────────────────────────

  it("broadcasts to all team members except sender", () => {
    tm.createTeam({ name: "crew", agents: ["alice", "bob", "charlie"] });

    const sent = tm.broadcast("alice", "crew", "Attention!");

    expect(sent).toHaveLength(2);
    expect(sent.map((m) => m.to).sort()).toEqual(["bob", "charlie"]);
  });

  it("throws when broadcasting to nonexistent team", () => {
    expect(() => tm.broadcast("alice", "ghost", "msg")).toThrow("not found");
  });

  // ── Message eviction ────────────────────────────────────────────

  it("evicts oldest messages when hitting max limit", () => {
    const limited = new TeamManager({ maxMessages: 10 });
    limited.setBus(bus);

    for (let i = 0; i < 10; i++) {
      limited.sendMessage("a", "b", `msg-${i}`);
    }

    // This should trigger eviction of the oldest 10%
    limited.sendMessage("a", "b", "overflow");

    // After eviction: removed 1 (10% of 10), then added 1 => 10 total
    const inbox = limited.getInbox("b");
    expect(inbox.length).toBeLessThanOrEqual(10);
    expect(inbox[inbox.length - 1].content).toBe("overflow");
  });

  // ── Inbox with wildcard ─────────────────────────────────────────

  it("includes wildcard-addressed messages in inbox", () => {
    tm.sendMessage("system", "*", "Broadcast to all");
    tm.sendMessage("alice", "bob", "Direct");

    const aliceInbox = tm.getInbox("alice");
    expect(aliceInbox).toHaveLength(1);
    expect(aliceInbox[0].to).toBe("*");

    const bobInbox = tm.getInbox("bob");
    expect(bobInbox).toHaveLength(2);
  });
});

/* ================================================================== */
/*  AgentMemory                                                        */
/* ================================================================== */

describe("AgentMemory", () => {
  let mem: AgentMemory;

  beforeEach(() => {
    mem = new AgentMemory();
  });

  // ── Write & Read ────────────────────────────────────────────────

  it("writes and reads a memory entry", () => {
    const entry = mem.write("coder", "project", "greeting", "hello");

    expect(entry.key).toBe("greeting");
    expect(entry.value).toBe("hello");
    expect(entry.scope).toBe("project");
    expect(entry.agentType).toBe("coder");
    expect(entry.createdAt).toBeGreaterThan(0);

    const read = mem.read("coder", "project", "greeting");
    expect(read).toBeDefined();
    expect(read!.value).toBe("hello");
  });

  it("returns undefined for nonexistent entries", () => {
    expect(mem.read("coder", "project", "missing")).toBeUndefined();
  });

  // ── Update existing ─────────────────────────────────────────────

  it("updates an existing entry preserving createdAt", () => {
    const original = mem.write("coder", "project", "key", "v1");
    const originalCreatedAt = original.createdAt;

    // Small delay to ensure updatedAt differs
    const updated = mem.write("coder", "project", "key", "v2");

    expect(updated.value).toBe("v2");
    expect(updated.createdAt).toBe(originalCreatedAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(originalCreatedAt);
  });

  // ── Scoping isolation ──────────────────────────────────────────

  it("isolates entries by agentType and scope", () => {
    mem.write("coder", "project", "key", "coder-project");
    mem.write("coder", "user", "key", "coder-user");
    mem.write("tester", "project", "key", "tester-project");

    expect(mem.read("coder", "project", "key")!.value).toBe("coder-project");
    expect(mem.read("coder", "user", "key")!.value).toBe("coder-user");
    expect(mem.read("tester", "project", "key")!.value).toBe(
      "tester-project",
    );
  });

  // ── List by type / scope ────────────────────────────────────────

  it("lists entries by agentType", () => {
    mem.write("coder", "project", "a", "1");
    mem.write("coder", "user", "b", "2");
    mem.write("tester", "project", "c", "3");

    const coderEntries = mem.list("coder");
    expect(coderEntries).toHaveLength(2);

    const testerEntries = mem.list("tester");
    expect(testerEntries).toHaveLength(1);
  });

  it("lists entries by agentType and scope", () => {
    mem.write("coder", "project", "a", "1");
    mem.write("coder", "user", "b", "2");
    mem.write("coder", "local", "c", "3");

    expect(mem.list("coder", "project")).toHaveLength(1);
    expect(mem.list("coder", "user")).toHaveLength(1);
    expect(mem.list("coder", "local")).toHaveLength(1);
  });

  // ── Delete ──────────────────────────────────────────────────────

  it("deletes an entry and returns true", () => {
    mem.write("coder", "project", "key", "val");
    expect(mem.delete("coder", "project", "key")).toBe(true);
    expect(mem.read("coder", "project", "key")).toBeUndefined();
  });

  it("returns false when deleting nonexistent entry", () => {
    expect(mem.delete("coder", "project", "nope")).toBe(false);
  });

  // ── List agent types ────────────────────────────────────────────

  it("lists all agent types that have memories", () => {
    mem.write("coder", "project", "a", "1");
    mem.write("tester", "project", "b", "2");
    mem.write("devops", "user", "c", "3");

    const types = mem.listAllAgentTypes();
    expect(types.sort()).toEqual(["coder", "devops", "tester"]);
  });

  // ── Serialization ──────────────────────────────────────────────

  it("round-trips via toJSON / loadFromJSON", () => {
    mem.write("coder", "project", "greeting", "hello");
    const json = mem.toJSON();

    const mem2 = new AgentMemory();
    mem2.loadFromJSON(json);

    expect(mem2.read("coder", "project", "greeting")!.value).toBe("hello");
  });
});

/* ================================================================== */
/*  GitTracker                                                         */
/* ================================================================== */

describe("GitTracker", () => {
  let gt: GitTracker;
  let bus: SharedStateBus;

  beforeEach(() => {
    bus = new SharedStateBus();
    gt = new GitTracker();
    gt.setBus(bus);
  });

  // ── Classification ──────────────────────────────────────────────

  describe("classifyCommand", () => {
    // Safe commands
    it.each([
      ["git log", "safe"],
      ["git status", "safe"],
      ["git diff", "safe"],
      ["git show HEAD", "safe"],
      ["git branch", "safe"],
      ["git branch --list", "safe"],
      ["git branch -a", "safe"],
      ["git remote -v", "safe"],
      ["git tag -l", "safe"],
      ["git stash list", "safe"],
    ] as const)('classifies "%s" as %s', (cmd, expected) => {
      expect(gt.classifyCommand(cmd)).toBe(expected);
    });

    // Mutating commands
    it.each([
      ["git add .", "mutating"],
      ["git commit -m 'msg'", "mutating"],
      ["git merge main", "mutating"],
      ["git rebase main", "mutating"],
      ["git cherry-pick abc123", "mutating"],
      ["git stash", "mutating"],
      ["git stash push", "mutating"],
      ["git fetch origin", "mutating"],
      ["git pull", "mutating"],
      ["git push origin main", "mutating"],
      ["git tag v1.0", "mutating"],
      ["git reset HEAD~1", "mutating"],
      ["git checkout feature", "mutating"],
      ["git restore file.txt", "mutating"],
    ] as const)('classifies "%s" as %s', (cmd, expected) => {
      expect(gt.classifyCommand(cmd)).toBe(expected);
    });

    // Destructive commands
    it.each([
      ["git reset --hard HEAD~1", "destructive"],
      ["git push --force origin main", "destructive"],
      ["git push -f origin main", "destructive"],
      ["git push --force-with-lease origin main", "destructive"],
      ["git clean -f", "destructive"],
      ["git clean -fd", "destructive"],
      ["git checkout -- .", "destructive"],
      ["git restore -- .", "destructive"],
      ["git branch -D feature", "destructive"],
      ["git branch -d feature", "destructive"],
      ["git stash drop", "destructive"],
      ["git stash clear", "destructive"],
      ["git rebase -i HEAD~3", "destructive"],
      ["git rebase --interactive HEAD~3", "destructive"],
    ] as const)('classifies "%s" as %s', (cmd, expected) => {
      expect(gt.classifyCommand(cmd)).toBe(expected);
    });

    // Edge cases
    it("handles command without 'git' prefix", () => {
      expect(gt.classifyCommand("status")).toBe("safe");
    });

    it("handles empty/whitespace command as safe", () => {
      expect(gt.classifyCommand("git")).toBe("safe");
      expect(gt.classifyCommand("  ")).toBe("safe");
    });

    it("handles unknown subcommands as safe", () => {
      expect(gt.classifyCommand("git bisect start")).toBe("safe");
    });

    it("is case-insensitive", () => {
      expect(gt.classifyCommand("GIT STATUS")).toBe("safe");
      expect(gt.classifyCommand("Git Push --Force origin main")).toBe(
        "destructive",
      );
    });
  });

  // ── Record operation ────────────────────────────────────────────

  it("records an operation with classification", () => {
    const op = gt.recordOperation("git status");

    expect(op.id).toMatch(/^gitop_\d+$/);
    expect(op.command).toBe("git status");
    expect(op.classification).toBe("safe");
    expect(op.timestamp).toBeGreaterThan(0);
  });

  it("publishes operation event on the bus", () => {
    const events = collectEvents(bus, "git:operation");
    gt.recordOperation("git commit -m 'test'");

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      classification: "mutating",
    });
  });

  // ── Get log / destructive ops ───────────────────────────────────

  it("returns a copy of the full audit log", () => {
    gt.recordOperation("git status");
    gt.recordOperation("git push --force origin main");

    const log = gt.getLog();
    expect(log).toHaveLength(2);

    // Verify it's a defensive copy (modifying returned array doesn't affect internal)
    log.pop();
    expect(gt.getLog()).toHaveLength(2);
  });

  it("filters destructive operations", () => {
    gt.recordOperation("git status");
    gt.recordOperation("git push --force origin main");
    gt.recordOperation("git commit -m 'x'");
    gt.recordOperation("git reset --hard");

    const destructive = gt.getDestructiveOps();
    expect(destructive).toHaveLength(2);
    expect(destructive.every((op) => op.classification === "destructive")).toBe(
      true,
    );
  });

  // ── Bounded log (500) ──────────────────────────────────────────

  it("enforces bounded log at 500 entries", () => {
    for (let i = 0; i < 510; i++) {
      gt.recordOperation(`git status`);
    }

    const log = gt.getLog();
    expect(log.length).toBeLessThanOrEqual(500);
  });
});

/* ================================================================== */
/*  CronScheduler                                                      */
/* ================================================================== */

describe("CronScheduler", () => {
  let cs: CronScheduler;
  let bus: SharedStateBus;

  beforeEach(() => {
    bus = new SharedStateBus();
    cs = new CronScheduler();
    cs.setBus(bus);
  });

  // ── matchesCron ─────────────────────────────────────────────────

  describe("matchesCron", () => {
    it("matches all-wildcard expression", () => {
      // * * * * * matches any date
      expect(matchesCron("* * * * *", new Date())).toBe(true);
    });

    it("matches specific minute and hour", () => {
      // 30 14 * * * = 2:30 PM every day
      const date = new Date(2024, 5, 15, 14, 30); // June 15, 2:30 PM
      expect(matchesCron("30 14 * * *", date)).toBe(true);
      expect(matchesCron("31 14 * * *", date)).toBe(false);
    });

    it("matches day-of-week (0 = Sunday)", () => {
      // * * * * 0 = every Sunday
      const sunday = new Date(2024, 5, 16, 12, 0); // June 16 2024 is a Sunday
      expect(matchesCron("* * * * 0", sunday)).toBe(true);
      expect(matchesCron("* * * * 1", sunday)).toBe(false);
    });

    it("handles 7 as Sunday alias", () => {
      const sunday = new Date(2024, 5, 16, 12, 0);
      expect(matchesCron("* * * * 7", sunday)).toBe(true);
    });

    it("handles step expressions", () => {
      // */15 * * * * = every 15 minutes
      const at0 = new Date(2024, 0, 1, 0, 0);
      const at15 = new Date(2024, 0, 1, 0, 15);
      const at30 = new Date(2024, 0, 1, 0, 30);
      const at7 = new Date(2024, 0, 1, 0, 7);

      expect(matchesCron("*/15 * * * *", at0)).toBe(true);
      expect(matchesCron("*/15 * * * *", at15)).toBe(true);
      expect(matchesCron("*/15 * * * *", at30)).toBe(true);
      expect(matchesCron("*/15 * * * *", at7)).toBe(false);
    });

    it("handles range expressions", () => {
      // * 9-17 * * * = 9 AM to 5 PM
      const at10 = new Date(2024, 0, 1, 10, 0);
      const at20 = new Date(2024, 0, 1, 20, 0);

      expect(matchesCron("* 9-17 * * *", at10)).toBe(true);
      expect(matchesCron("* 9-17 * * *", at20)).toBe(false);
    });

    it("handles comma-separated values", () => {
      // 0,15,30,45 * * * *
      const at0 = new Date(2024, 0, 1, 0, 0);
      const at15 = new Date(2024, 0, 1, 0, 15);
      const at10 = new Date(2024, 0, 1, 0, 10);

      expect(matchesCron("0,15,30,45 * * * *", at0)).toBe(true);
      expect(matchesCron("0,15,30,45 * * * *", at15)).toBe(true);
      expect(matchesCron("0,15,30,45 * * * *", at10)).toBe(false);
    });

    it("handles range with step", () => {
      // 1-30/10 * * * * = minutes 1, 11, 21
      const at1 = new Date(2024, 0, 1, 0, 1);
      const at11 = new Date(2024, 0, 1, 0, 11);
      const at21 = new Date(2024, 0, 1, 0, 21);
      const at5 = new Date(2024, 0, 1, 0, 5);

      expect(matchesCron("1-30/10 * * * *", at1)).toBe(true);
      expect(matchesCron("1-30/10 * * * *", at11)).toBe(true);
      expect(matchesCron("1-30/10 * * * *", at21)).toBe(true);
      expect(matchesCron("1-30/10 * * * *", at5)).toBe(false);
    });

    it("rejects invalid field count", () => {
      expect(matchesCron("* * *", new Date())).toBe(false);
      expect(matchesCron("* * * * * *", new Date())).toBe(false);
    });

    it("handles specific month", () => {
      // * * * 6 * = June only
      const june = new Date(2024, 5, 1, 0, 0); // month 5 = June (0-indexed)
      const jan = new Date(2024, 0, 1, 0, 0);

      expect(matchesCron("* * * 6 *", june)).toBe(true);
      expect(matchesCron("* * * 6 *", jan)).toBe(false);
    });
  });

  // ── Create job ──────────────────────────────────────────────────

  it("creates a recurring job by default", () => {
    const job = cs.createJob({ cron: "*/5 * * * *", prompt: "check status" });

    expect(job.id).toMatch(/^cron_\d+$/);
    expect(job.cron).toBe("*/5 * * * *");
    expect(job.prompt).toBe("check status");
    expect(job.recurring).toBe(true);
    expect(job.fireCount).toBe(0);
    expect(job.expiresAt).toBeGreaterThan(job.createdAt);
  });

  it("creates a one-shot job", () => {
    const job = cs.createJob({
      cron: "0 12 * * *",
      prompt: "once only",
      recurring: false,
    });
    expect(job.recurring).toBe(false);
  });

  it("rejects invalid cron expressions", () => {
    expect(() =>
      cs.createJob({ cron: "bad expression", prompt: "nope" }),
    ).toThrow("Invalid cron expression");
  });

  it("rejects cron with wrong field count", () => {
    expect(() => cs.createJob({ cron: "* * *", prompt: "nope" })).toThrow(
      "Expected 5 fields",
    );
  });

  it("publishes created event", () => {
    const events = collectEvents(bus, "state:cron");
    cs.createJob({ cron: "* * * * *", prompt: "test" });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ action: "created" });
  });

  // ── Max limit ───────────────────────────────────────────────────

  it("enforces maximum job limit", () => {
    const limited = new CronScheduler({ maxJobs: 2 });
    limited.setBus(bus);

    limited.createJob({ cron: "* * * * *", prompt: "1" });
    limited.createJob({ cron: "* * * * *", prompt: "2" });

    expect(() =>
      limited.createJob({ cron: "* * * * *", prompt: "3" }),
    ).toThrow("Maximum job limit");
  });

  // ── Delete ──────────────────────────────────────────────────────

  it("deletes a job by ID", () => {
    const job = cs.createJob({ cron: "* * * * *", prompt: "x" });
    expect(cs.deleteJob(job.id)).toBe(true);
    expect(cs.getJob(job.id)).toBeUndefined();
  });

  it("returns false when deleting nonexistent job", () => {
    expect(cs.deleteJob("cron_999")).toBe(false);
  });

  // ── Tick fires correct jobs ─────────────────────────────────────

  it("fires a job when the cron expression matches", () => {
    // Job that fires every minute
    cs.createJob({ cron: "* * * * *", prompt: "always fire" });

    const now = Date.now();
    const fired = cs.tick(now);

    expect(fired).toHaveLength(1);
    expect(fired[0].prompt).toBe("always fire");
    expect(fired[0].fireCount).toBe(1);
  });

  it("does not fire a job when the expression does not match", () => {
    // Job fires only at minute 0
    cs.createJob({ cron: "0 * * * *", prompt: "hourly" });

    // Tick at minute 30
    const date = new Date(2024, 0, 1, 12, 30);
    const fired = cs.tick(date.getTime());

    expect(fired).toHaveLength(0);
  });

  it("publishes fired event", () => {
    const events = collectEvents(bus, "cron:fired");
    cs.createJob({ cron: "* * * * *", prompt: "fire me" });
    cs.tick(Date.now());

    expect(events).toHaveLength(1);
  });

  // ── One-shot auto-delete ────────────────────────────────────────

  it("auto-deletes one-shot jobs after firing", () => {
    const job = cs.createJob({
      cron: "* * * * *",
      prompt: "once",
      recurring: false,
    });

    cs.tick(Date.now());

    // Job should be gone after tick
    expect(cs.getJob(job.id)).toBeUndefined();
    expect(cs.listJobs()).toHaveLength(0);
  });

  // ── Expiration cleanup ──────────────────────────────────────────

  it("removes expired jobs during tick", () => {
    const job = cs.createJob({ cron: "* * * * *", prompt: "expirable" });

    // Tick far in the future (past expiration)
    const futureMs = Date.now() + 8 * 24 * 60 * 60 * 1000; // 8 days
    const fired = cs.tick(futureMs);

    // Job should have been expired (not fired) and deleted
    expect(cs.getJob(job.id)).toBeUndefined();
    // It should NOT have fired because expiration is checked first
    expect(fired).toHaveLength(0);
  });

  // ── Tick dedup (no double-fire in same minute) ──────────────────

  it("does not fire the same job twice in the same calendar minute", () => {
    cs.createJob({ cron: "* * * * *", prompt: "dedup" });

    const baseDate = new Date(2024, 0, 1, 12, 30, 0); // 12:30:00
    const sameMinute = new Date(2024, 0, 1, 12, 30, 30); // 12:30:30

    const fired1 = cs.tick(baseDate.getTime());
    expect(fired1).toHaveLength(1);

    const fired2 = cs.tick(sameMinute.getTime());
    expect(fired2).toHaveLength(0);
  });

  it("fires again in a different minute", () => {
    cs.createJob({ cron: "* * * * *", prompt: "per-minute" });

    const minute1 = new Date(2024, 0, 1, 12, 30, 0);
    const minute2 = new Date(2024, 0, 1, 12, 31, 0);

    cs.tick(minute1.getTime());
    const fired = cs.tick(minute2.getTime());

    expect(fired).toHaveLength(1);
  });

  // ── Serialization ──────────────────────────────────────────────

  it("round-trips via toJSON / loadFromJSON", () => {
    const job = cs.createJob({ cron: "*/5 * * * *", prompt: "saved" });
    const json = cs.toJSON();

    const cs2 = new CronScheduler();
    cs2.loadFromJSON(json);

    expect(cs2.getJob(job.id)).toBeDefined();
    expect(cs2.getJob(job.id)!.prompt).toBe("saved");
  });
});

/* ================================================================== */
/*  WorktreeManager                                                    */
/* ================================================================== */

describe("WorktreeManager", () => {
  let wm: WorktreeManager;
  let bus: SharedStateBus;

  beforeEach(() => {
    bus = new SharedStateBus();
    wm = new WorktreeManager();
    wm.setBus(bus);
  });

  // ── Create worktree ─────────────────────────────────────────────

  it("creates a worktree with generated path and branch", () => {
    const wt = wm.createWorktree({
      name: "my-feature",
      originalCwd: "/home/user",
    });

    expect(wt.id).toMatch(/^wt_\d+$/);
    expect(wt.name).toBe("my-feature");
    expect(wt.path).toBe("/.ag-bash/worktrees/my-feature");
    expect(wt.branch).toBe("worktree/my-feature");
    expect(wt.originalCwd).toBe("/home/user");
    expect(wt.createdAt).toBeGreaterThan(0);
  });

  it("creates a worktree with explicit branch", () => {
    const wt = wm.createWorktree({
      name: "hotfix",
      branch: "hotfix/v1.2.3",
      originalCwd: "/tmp",
    });

    expect(wt.branch).toBe("hotfix/v1.2.3");
  });

  it("publishes created event", () => {
    const events = collectEvents(bus, "worktree:created");
    wm.createWorktree({ name: "x", originalCwd: "/" });
    expect(events).toHaveLength(1);
  });

  // ── Duplicate name ──────────────────────────────────────────────

  it("rejects duplicate worktree names", () => {
    wm.createWorktree({ name: "dup", originalCwd: "/" });
    expect(() =>
      wm.createWorktree({ name: "dup", originalCwd: "/" }),
    ).toThrow("already exists");
  });

  // ── Enter / Exit ────────────────────────────────────────────────

  it("enters a worktree by name", () => {
    wm.createWorktree({ name: "feat", originalCwd: "/home" });
    const entered = wm.enterWorktree("feat");

    expect(entered.name).toBe("feat");
    expect(wm.getActive()).toBeDefined();
    expect(wm.getActive()!.name).toBe("feat");
  });

  it("enters a worktree by ID", () => {
    const wt = wm.createWorktree({ name: "feat2", originalCwd: "/home" });
    wm.enterWorktree(wt.id);
    expect(wm.getActive()!.id).toBe(wt.id);
  });

  it("throws when entering a nonexistent worktree", () => {
    expect(() => wm.enterWorktree("ghost")).toThrow("not found");
  });

  it("publishes enter event", () => {
    const events = collectEvents(bus, "worktree:enter");
    wm.createWorktree({ name: "x", originalCwd: "/" });
    wm.enterWorktree("x");
    expect(events).toHaveLength(1);
  });

  it("exits the active worktree and returns originalCwd", () => {
    wm.createWorktree({ name: "feat", originalCwd: "/my/project" });
    wm.enterWorktree("feat");

    const result = wm.exitWorktree();
    expect(result).not.toBeNull();
    expect(result!.originalCwd).toBe("/my/project");
    expect(wm.getActive()).toBeUndefined();
  });

  it("returns null when exiting with no active worktree", () => {
    expect(wm.exitWorktree()).toBeNull();
  });

  it("publishes exit event", () => {
    const events = collectEvents(bus, "worktree:exit");
    wm.createWorktree({ name: "x", originalCwd: "/" });
    wm.enterWorktree("x");
    wm.exitWorktree();
    expect(events).toHaveLength(1);
  });

  // ── Get active ──────────────────────────────────────────────────

  it("returns undefined when no worktree is active", () => {
    expect(wm.getActive()).toBeUndefined();
  });

  it("returns a defensive copy from getActive", () => {
    wm.createWorktree({ name: "safe", originalCwd: "/" });
    wm.enterWorktree("safe");

    const active1 = wm.getActive()!;
    const active2 = wm.getActive()!;
    expect(active1).not.toBe(active2); // different object references
    expect(active1).toEqual(active2); // same values
  });

  // ── Delete worktree ─────────────────────────────────────────────

  it("deletes a worktree by name", () => {
    wm.createWorktree({ name: "gone", originalCwd: "/" });
    expect(wm.deleteWorktree("gone")).toBe(true);
    expect(wm.listWorktrees()).toHaveLength(0);
  });

  it("deletes a worktree by ID", () => {
    const wt = wm.createWorktree({ name: "gone2", originalCwd: "/" });
    expect(wm.deleteWorktree(wt.id)).toBe(true);
  });

  it("clears active reference when deleting the active worktree", () => {
    wm.createWorktree({ name: "active-del", originalCwd: "/" });
    wm.enterWorktree("active-del");
    expect(wm.getActive()).toBeDefined();

    wm.deleteWorktree("active-del");
    expect(wm.getActive()).toBeUndefined();
  });

  it("returns false when deleting nonexistent worktree", () => {
    expect(wm.deleteWorktree("phantom")).toBe(false);
  });

  it("publishes deleted event", () => {
    const events = collectEvents(bus, "worktree:deleted");
    wm.createWorktree({ name: "x", originalCwd: "/" });
    wm.deleteWorktree("x");
    expect(events).toHaveLength(1);
  });

  // ── List ────────────────────────────────────────────────────────

  it("lists all worktrees as defensive copies", () => {
    wm.createWorktree({ name: "a", originalCwd: "/" });
    wm.createWorktree({ name: "b", originalCwd: "/" });

    const list = wm.listWorktrees();
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.name).sort()).toEqual(["a", "b"]);
  });

  // ── Get by ID or name ───────────────────────────────────────────

  it("finds worktree by ID or name", () => {
    const wt = wm.createWorktree({ name: "findme", originalCwd: "/" });

    expect(wm.getWorktree(wt.id)).toBeDefined();
    expect(wm.getWorktree("findme")).toBeDefined();
    expect(wm.getWorktree("nothere")).toBeUndefined();
  });
});
