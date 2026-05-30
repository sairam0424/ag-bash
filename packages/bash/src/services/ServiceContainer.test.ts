/**
 * ServiceContainer unit tests.
 *
 * Verifies dependency injection, override mechanism, container isolation,
 * and dispose lifecycle management.
 */

import { describe, expect, it, vi } from "vitest";
import { AgentMemory, type MemoryEntry } from "./AgentMemory.js";
import type { SyncFs } from "./AgentMemorySync.js";
import { CronScheduler } from "./CronScheduler.js";
import { GitTracker } from "./GitTracker.js";
import { createDefaultServices } from "./ServiceContainer.js";
import { SessionManager } from "./SessionManager.js";
import { SharedStateBus } from "./SharedStateBus.js";
import { TaskManager } from "./TaskManager.js";
import { TeamManager } from "./TeamManager.js";
import { WorktreeManager } from "./WorktreeManager.js";

/**
 * Minimal in-memory SyncFs for AgentMemory persistence tests. Backed by a
 * null-prototype Map; never mutates input objects. Implemented as a class so
 * tests avoid bare `{}` object-literal stores.
 */
class FakeSyncFs implements SyncFs {
  private readonly files = new Map<string, string>();

  async exists(path: string): Promise<boolean> {
    if (this.files.has(path)) return true;
    // Treat a path as an existing directory if any file lives beneath it.
    const prefix = `${path}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  async readFile(path: string, _encoding?: "utf-8"): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async mkdir(
    _path: string,
    _options?: { recursive?: boolean },
  ): Promise<void> {
    // No-op: existence is inferred from stored file paths.
  }

  /** Seed a file directly (test helper). */
  seed(path: string, content: string): void {
    this.files.set(path, content);
  }

  /** Read raw stored content without going through the async API. */
  raw(path: string): string | undefined {
    return this.files.get(path);
  }
}

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    key: overrides.key ?? "k",
    value: overrides.value ?? "v",
    scope: overrides.scope ?? "project",
    agentType: overrides.agentType ?? "planner",
    createdAt: overrides.createdAt ?? 1000,
    updatedAt: overrides.updatedAt ?? 1000,
  };
}

/* ================================================================== */
/*  createDefaultServices                                              */
/* ================================================================== */

describe("ServiceContainer", () => {
  describe("createDefaultServices", () => {
    it("returns all expected service properties", () => {
      const container = createDefaultServices();

      expect(container.astCache).toBeDefined();
      expect(container.sharedBus).toBeDefined();
      expect(container.sessionManager).toBeDefined();
      expect(container.agentManager).toBeDefined();
      expect(container.mcpClient).toBeDefined();
      expect(container.orchestrator).toBeDefined();
      expect(container.lspManager).toBeDefined();
      expect(container.taskManager).toBeDefined();
      expect(container.teamManager).toBeDefined();
      expect(container.agentMemory).toBeDefined();
      expect(container.gitTracker).toBeDefined();
      expect(container.cronScheduler).toBeDefined();
      expect(container.worktreeManager).toBeDefined();
      expect(container.parser).toBeDefined();
      expect(container.dispose).toBeInstanceOf(Function);
    });

    it("returns service instances of the correct types", () => {
      const container = createDefaultServices();

      expect(container.sharedBus).toBeInstanceOf(SharedStateBus);
      expect(container.cronScheduler).toBeInstanceOf(CronScheduler);
      expect(container.sessionManager).toBeInstanceOf(SessionManager);
      expect(container.taskManager).toBeInstanceOf(TaskManager);
      expect(container.teamManager).toBeInstanceOf(TeamManager);
      expect(container.gitTracker).toBeInstanceOf(GitTracker);
      expect(container.worktreeManager).toBeInstanceOf(WorktreeManager);
    });

    it("wires bus-dependent services with the shared bus", () => {
      const container = createDefaultServices();
      const bus = container.sharedBus;

      // Verify the bus is wired by creating a task and checking bus events
      const events: unknown[] = [];
      bus.subscribe("state:tasks", (e) => events.push(e));
      container.taskManager.create({
        subject: "test",
        description: "verify bus wiring",
      });

      expect(events).toHaveLength(1);
    });
  });

  /* ================================================================ */
  /*  Override mechanism                                                */
  /* ================================================================ */

  describe("override mechanism", () => {
    it("uses provided SharedStateBus override", () => {
      const customBus = new SharedStateBus();
      const container = createDefaultServices({ sharedBus: customBus });

      expect(container.sharedBus).toBe(customBus);
    });

    it("uses provided CronScheduler override", () => {
      const customScheduler = new CronScheduler({ maxJobs: 5 });
      const container = createDefaultServices({
        cronScheduler: customScheduler,
      });

      expect(container.cronScheduler).toBe(customScheduler);
    });

    it("uses provided TaskManager override", () => {
      const customTaskManager = new TaskManager({ maxTasks: 3 });
      const container = createDefaultServices({
        taskManager: customTaskManager,
      });

      expect(container.taskManager).toBe(customTaskManager);
    });

    it("uses provided TeamManager override", () => {
      const customTeamManager = new TeamManager({ maxTeams: 2 });
      const container = createDefaultServices({
        teamManager: customTeamManager,
      });

      expect(container.teamManager).toBe(customTeamManager);
    });

    it("uses provided GitTracker override", () => {
      const customGitTracker = new GitTracker();
      const container = createDefaultServices({ gitTracker: customGitTracker });

      expect(container.gitTracker).toBe(customGitTracker);
    });

    it("uses provided WorktreeManager override", () => {
      const customWorktreeManager = new WorktreeManager();
      const container = createDefaultServices({
        worktreeManager: customWorktreeManager,
      });

      expect(container.worktreeManager).toBe(customWorktreeManager);
    });

    it("uses provided SessionManager override", () => {
      const customSessionManager = new SessionManager();
      const container = createDefaultServices({
        sessionManager: customSessionManager,
      });

      expect(container.sessionManager).toBe(customSessionManager);
    });

    it("wires overridden bus into other services", () => {
      const customBus = new SharedStateBus();
      const container = createDefaultServices({ sharedBus: customBus });

      // The custom bus should receive events from bus-wired services
      const events: unknown[] = [];
      customBus.subscribe("state:teams", (e) => events.push(e));
      container.teamManager.createTeam({ name: "test-team" });

      expect(events).toHaveLength(1);
    });

    it("supports partial overrides while defaulting the rest", () => {
      const customBus = new SharedStateBus();
      const container = createDefaultServices({ sharedBus: customBus });

      // Bus is overridden
      expect(container.sharedBus).toBe(customBus);
      // Others are freshly created defaults
      expect(container.taskManager).toBeInstanceOf(TaskManager);
      expect(container.cronScheduler).toBeInstanceOf(CronScheduler);
    });
  });

  /* ================================================================ */
  /*  Container isolation                                              */
  /* ================================================================ */

  describe("container isolation", () => {
    it("multiple containers have independent shared buses", () => {
      const container1 = createDefaultServices();
      const container2 = createDefaultServices();

      expect(container1.sharedBus).not.toBe(container2.sharedBus);
    });

    it("multiple containers have independent task managers", () => {
      const container1 = createDefaultServices();
      const container2 = createDefaultServices();

      container1.taskManager.create({ subject: "task1", description: "" });

      expect(container1.taskManager.list()).toHaveLength(1);
      expect(container2.taskManager.list()).toHaveLength(0);
    });

    it("multiple containers have independent cron schedulers", () => {
      const container1 = createDefaultServices();
      const container2 = createDefaultServices();

      container1.cronScheduler.createJob({ cron: "* * * * *", prompt: "job1" });

      expect(container1.cronScheduler.listJobs()).toHaveLength(1);
      expect(container2.cronScheduler.listJobs()).toHaveLength(0);
    });

    it("multiple containers have independent team managers", () => {
      const container1 = createDefaultServices();
      const container2 = createDefaultServices();

      container1.teamManager.createTeam({ name: "alpha" });

      expect(container1.teamManager.listTeams()).toHaveLength(1);
      expect(container2.teamManager.listTeams()).toHaveLength(0);
    });

    it("events on one container bus do not leak to another", () => {
      const container1 = createDefaultServices();
      const container2 = createDefaultServices();

      const events1: unknown[] = [];
      const events2: unknown[] = [];

      container1.sharedBus.subscribe("state:tasks", (e) => events1.push(e));
      container2.sharedBus.subscribe("state:tasks", (e) => events2.push(e));

      container1.taskManager.create({ subject: "isolated", description: "" });

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(0);
    });
  });

  /* ================================================================ */
  /*  dispose()                                                         */
  /* ================================================================ */

  describe("dispose()", () => {
    it("calls dispose on cronScheduler", async () => {
      const container = createDefaultServices();
      const disposeSpy = vi.spyOn(container.cronScheduler, "dispose");

      await container.dispose();

      expect(disposeSpy).toHaveBeenCalledOnce();
    });

    it("calls dispose on gitTracker", async () => {
      const container = createDefaultServices();
      const disposeSpy = vi.spyOn(container.gitTracker, "dispose");

      await container.dispose();

      expect(disposeSpy).toHaveBeenCalledOnce();
    });

    it("calls dispose on mcpClient", async () => {
      const container = createDefaultServices();
      const disposeSpy = vi.spyOn(container.mcpClient, "dispose");

      await container.dispose();

      expect(disposeSpy).toHaveBeenCalledOnce();
    });

    it("calls dispose on sessionManager", async () => {
      const container = createDefaultServices();
      const disposeSpy = vi.spyOn(container.sessionManager, "dispose");

      await container.dispose();

      expect(disposeSpy).toHaveBeenCalledOnce();
    });

    it("calls destroy on sharedBus", async () => {
      const container = createDefaultServices();
      const destroySpy = vi.spyOn(container.sharedBus, "destroy");

      await container.dispose();

      expect(destroySpy).toHaveBeenCalledOnce();
    });

    it("is idempotent (safe to call multiple times)", async () => {
      const container = createDefaultServices();
      const disposeSpy = vi.spyOn(container.cronScheduler, "dispose");

      await container.dispose();
      await container.dispose();
      await container.dispose();

      expect(disposeSpy).toHaveBeenCalledOnce();
    });

    it("disposes in reverse creation order", async () => {
      const container = createDefaultServices();
      const callOrder: string[] = [];

      vi.spyOn(container.cronScheduler, "dispose").mockImplementation(
        async () => {
          callOrder.push("cronScheduler");
        },
      );
      vi.spyOn(container.gitTracker, "dispose").mockImplementation(async () => {
        callOrder.push("gitTracker");
      });
      vi.spyOn(container.mcpClient, "dispose").mockImplementation(async () => {
        callOrder.push("mcpClient");
      });
      vi.spyOn(container.sessionManager, "dispose").mockImplementation(
        async () => {
          callOrder.push("sessionManager");
        },
      );
      vi.spyOn(container.sharedBus, "destroy").mockImplementation(() => {
        callOrder.push("sharedBus");
      });

      await container.dispose();

      expect(callOrder).toEqual([
        "cronScheduler",
        "gitTracker",
        "mcpClient",
        "sessionManager",
        "sharedBus",
      ]);
    });

    it("disposes EVERY instantiated disposable service (registry-driven)", async () => {
      const container = createDefaultServices();

      // Touch all four disposable services so they are instantiated.
      const spies = [
        vi.spyOn(container.cronScheduler, "dispose"),
        vi.spyOn(container.gitTracker, "dispose"),
        vi.spyOn(container.mcpClient, "dispose"),
        vi.spyOn(container.sessionManager, "dispose"),
      ];

      await container.dispose();

      for (const spy of spies) {
        expect(spy).toHaveBeenCalledOnce();
      }
    });

    it("does not instantiate (nor dispose) services that were never accessed", async () => {
      const container = createDefaultServices();

      // Only touch cronScheduler; the other disposables stay uninstantiated.
      const cronSpy = vi.spyOn(container.cronScheduler, "dispose");

      // Spy on the prototypes so we can detect any disposal of an
      // un-accessed instance.
      const sessionProtoSpy = vi.spyOn(SessionManager.prototype, "dispose");

      await container.dispose();

      expect(cronSpy).toHaveBeenCalledOnce();
      // sessionManager was never accessed, so its dispose must never run.
      expect(sessionProtoSpy).not.toHaveBeenCalled();
    });

    it("aggregates errors from multiple failing disposables", async () => {
      const container = createDefaultServices();

      vi.spyOn(container.cronScheduler, "dispose").mockRejectedValue(
        new Error("cron boom"),
      );
      vi.spyOn(container.gitTracker, "dispose").mockRejectedValue(
        new Error("git boom"),
      );

      await expect(container.dispose()).rejects.toThrowError(AggregateError);
    });
  });

  /* ================================================================ */
  /*  bus wiring (centralized in the registry)                         */
  /* ================================================================ */

  describe("bus wiring", () => {
    it("wires the bus exactly once per bus-aware service", () => {
      // Spy on the prototype BEFORE the instance is constructed so we capture
      // the single wiring call performed during lazy construction.
      const setBusSpy = vi.spyOn(TaskManager.prototype, "setBus");

      const container = createDefaultServices();

      // Multiple accesses share the memoized instance; wiring happens once.
      void container.taskManager;
      void container.taskManager;
      void container.taskManager;

      expect(setBusSpy).toHaveBeenCalledTimes(1);
      expect(setBusSpy).toHaveBeenCalledWith(container.sharedBus);
    });

    it("each bus-aware service receives the shared bus on first access", () => {
      const container = createDefaultServices();
      const bus = container.sharedBus;

      const teamEvents: unknown[] = [];
      const gitEvents: unknown[] = [];
      const cronEvents: unknown[] = [];
      const worktreeEvents: unknown[] = [];

      bus.subscribe("state:teams", (e) => teamEvents.push(e));
      bus.subscribe("state:git", (e) => gitEvents.push(e));
      bus.subscribe("state:cron", (e) => cronEvents.push(e));
      bus.subscribe("state:worktrees", (e) => worktreeEvents.push(e));

      container.teamManager.createTeam({ name: "t" });
      container.cronScheduler.createJob({ cron: "* * * * *", prompt: "p" });

      // teamManager and cronScheduler are bus-aware; their mutations publish.
      expect(teamEvents.length).toBeGreaterThan(0);
      expect(cronEvents.length).toBeGreaterThan(0);
    });
  });

  /* ================================================================ */
  /*  AgentMemory persistence                                          */
  /* ================================================================ */

  describe("AgentMemory persistence", () => {
    it("hydrates AgentMemory from a seeded VFS on first access", async () => {
      const fs = new FakeSyncFs();
      const entry = makeEntry({
        agentType: "planner",
        scope: "project",
        key: "goal",
        value: "ship v6",
        createdAt: 5,
        updatedAt: 5,
      });
      fs.seed(
        "/.ag-bash/agent-memory/project/.manifest.json",
        JSON.stringify(["planner"]),
      );
      fs.seed(
        "/.ag-bash/agent-memory/project/planner.json",
        JSON.stringify([entry]),
      );

      const container = createDefaultServices(undefined, () => fs);

      // First access returns the instance immediately (sync getter).
      expect(container.agentMemory).toBeInstanceOf(AgentMemory);

      // After awaiting hydration the seeded entry is present.
      await container.ensureAgentMemoryHydrated();
      const loaded = container.agentMemory.read("planner", "project", "goal");
      expect(loaded?.value).toBe("ship v6");
      expect(loaded?.updatedAt).toBe(5);
    });

    it("round-trips memory back to the VFS via saveMemoryToFs on dispose", async () => {
      const fs = new FakeSyncFs();
      const container = createDefaultServices(undefined, () => fs);

      await container.ensureAgentMemoryHydrated();
      container.agentMemory.write("reviewer", "user", "style", "concise");

      await container.dispose();

      const raw = fs.raw("/.ag-bash/agent-memory/user/reviewer.json");
      expect(raw).toBeDefined();
      const parsed = JSON.parse(raw as string) as MemoryEntry[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.value).toBe("concise");
    });

    it("tolerates an empty/missing VFS during hydration", async () => {
      const fs = new FakeSyncFs(); // completely empty
      const container = createDefaultServices(undefined, () => fs);

      await expect(
        container.ensureAgentMemoryHydrated(),
      ).resolves.toBeUndefined();
      // No entries hydrated, instance still usable.
      expect(container.agentMemory.listAllAgentTypes()).toEqual([]);
    });

    it("dispose does not write when AgentMemory was never accessed", async () => {
      const fs = new FakeSyncFs();
      const writeSpy = vi.spyOn(fs, "writeFile");

      const container = createDefaultServices(undefined, () => fs);
      // Never touch agentMemory.
      await container.dispose();

      expect(writeSpy).not.toHaveBeenCalled();
    });

    it("ensureAgentMemoryHydrated resolves when no fs accessor is provided", async () => {
      const container = createDefaultServices();
      await expect(
        container.ensureAgentMemoryHydrated(),
      ).resolves.toBeUndefined();
      expect(container.agentMemory).toBeInstanceOf(AgentMemory);
    });

    it("respects an AgentMemory override (bypasses factory + hydration wiring)", async () => {
      const fs = new FakeSyncFs();
      fs.seed(
        "/.ag-bash/agent-memory/project/.manifest.json",
        JSON.stringify(["planner"]),
      );
      fs.seed(
        "/.ag-bash/agent-memory/project/planner.json",
        JSON.stringify([
          makeEntry({ agentType: "planner", key: "k", value: "from-disk" }),
        ]),
      );

      const custom = new AgentMemory();
      const container = createDefaultServices(
        { agentMemory: custom },
        () => fs,
      );

      expect(container.agentMemory).toBe(custom);
      // The override was pre-supplied, so the disk entry is NOT auto-merged
      // (hydration is only scheduled when the factory constructs the instance).
      await container.ensureAgentMemoryHydrated();
      expect(
        container.agentMemory.read("planner", "project", "k"),
      ).toBeUndefined();
    });
  });
});
