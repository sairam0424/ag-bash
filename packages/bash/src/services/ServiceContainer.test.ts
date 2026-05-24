/**
 * ServiceContainer unit tests.
 *
 * Verifies dependency injection, override mechanism, container isolation,
 * and dispose lifecycle management.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultServices, type ServiceContainer } from "./ServiceContainer.js";
import { CronScheduler } from "./CronScheduler.js";
import { SharedStateBus } from "./SharedStateBus.js";
import { SessionManager } from "./SessionManager.js";
import { TaskManager } from "./TaskManager.js";
import { TeamManager } from "./TeamManager.js";
import { GitTracker } from "./GitTracker.js";
import { WorktreeManager } from "./WorktreeManager.js";

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
      container.taskManager.create({ subject: "test", description: "verify bus wiring" });

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
      const container = createDefaultServices({ cronScheduler: customScheduler });

      expect(container.cronScheduler).toBe(customScheduler);
    });

    it("uses provided TaskManager override", () => {
      const customTaskManager = new TaskManager({ maxTasks: 3 });
      const container = createDefaultServices({ taskManager: customTaskManager });

      expect(container.taskManager).toBe(customTaskManager);
    });

    it("uses provided TeamManager override", () => {
      const customTeamManager = new TeamManager({ maxTeams: 2 });
      const container = createDefaultServices({ teamManager: customTeamManager });

      expect(container.teamManager).toBe(customTeamManager);
    });

    it("uses provided GitTracker override", () => {
      const customGitTracker = new GitTracker();
      const container = createDefaultServices({ gitTracker: customGitTracker });

      expect(container.gitTracker).toBe(customGitTracker);
    });

    it("uses provided WorktreeManager override", () => {
      const customWorktreeManager = new WorktreeManager();
      const container = createDefaultServices({ worktreeManager: customWorktreeManager });

      expect(container.worktreeManager).toBe(customWorktreeManager);
    });

    it("uses provided SessionManager override", () => {
      const customSessionManager = new SessionManager();
      const container = createDefaultServices({ sessionManager: customSessionManager });

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

      vi.spyOn(container.cronScheduler, "dispose").mockImplementation(async () => {
        callOrder.push("cronScheduler");
      });
      vi.spyOn(container.gitTracker, "dispose").mockImplementation(async () => {
        callOrder.push("gitTracker");
      });
      vi.spyOn(container.mcpClient, "dispose").mockImplementation(async () => {
        callOrder.push("mcpClient");
      });
      vi.spyOn(container.sessionManager, "dispose").mockImplementation(async () => {
        callOrder.push("sessionManager");
      });
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
  });
});
