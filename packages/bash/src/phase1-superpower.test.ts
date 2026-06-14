import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";
import { InMemoryFs } from "./fs/in-memory-fs/index.js";

describe("Phase 1: Superpower Tools", () => {
  let bash: Bash;

  beforeEach(() => {
    bash = new Bash({ fs: new InMemoryFs(), agentic: { enabled: true } });
  });

  describe("TaskManager Service", () => {
    it("should create and list tasks", () => {
      const tm = bash.services.taskManager;
      const task = tm.create({
        subject: "Fix bug",
        description: "Fix the login bug",
      });
      expect(task.id).toMatch(/^task_/);
      expect(task.status).toBe("pending");
      expect(tm.list()).toHaveLength(1);
    });

    it("should enforce status transitions", () => {
      const tm = bash.services.taskManager;
      const task = tm.create({ subject: "Test", description: "Test task" });
      tm.update(task.id, { status: "in_progress" });
      expect(tm.get(task.id)?.status).toBe("in_progress");

      expect(() => tm.update(task.id, { status: "pending" })).toThrow(
        "Invalid transition",
      );
    });

    it("should resolve blocked tasks on completion", () => {
      const tm = bash.services.taskManager;
      const blocker = tm.create({
        subject: "Build",
        description: "Build first",
      });
      const blocked = tm.create({
        subject: "Deploy",
        description: "Deploy after",
      });

      tm.update(blocked.id, { status: "blocked", addBlockedBy: [blocker.id] });
      expect(tm.get(blocked.id)?.status).toBe("blocked");

      tm.update(blocker.id, { status: "in_progress" });
      tm.update(blocker.id, { status: "completed" });

      expect(tm.get(blocked.id)?.status).toBe("pending");
    });

    it("should delete tasks and clean up dependencies", () => {
      const tm = bash.services.taskManager;
      const t1 = tm.create({ subject: "A", description: "Task A" });
      const t2 = tm.create({ subject: "B", description: "Task B" });
      tm.update(t2.id, { addBlockedBy: [t1.id] });

      expect(tm.delete(t1.id)).toBe(true);
      expect(tm.get(t2.id)?.blockedBy).toEqual([]);
    });
  });

  describe("TeamManager Service", () => {
    it("should create teams and manage agents", () => {
      const tm = bash.services.teamManager;
      const team = tm.createTeam({ name: "alpha", description: "Frontend" });
      expect(team.name).toBe("alpha");

      tm.addAgentToTeam("alpha", "agent1");
      tm.addAgentToTeam("alpha", "agent2");
      expect(tm.getTeam("alpha")?.agents).toEqual(["agent1", "agent2"]);

      tm.removeAgentFromTeam("alpha", "agent1");
      expect(tm.getTeam("alpha")?.agents).toEqual(["agent2"]);
    });

    it("should prevent duplicate team names", () => {
      const tm = bash.services.teamManager;
      tm.createTeam({ name: "beta" });
      expect(() => tm.createTeam({ name: "beta" })).toThrow("already exists");
    });

    it("should send and receive messages", () => {
      const tm = bash.services.teamManager;
      tm.sendMessage("agent1", "agent2", "Hello!");
      tm.sendMessage("agent3", "agent2", "Hi there");

      const inbox = tm.getInbox("agent2");
      expect(inbox).toHaveLength(2);
      expect(inbox[0].content).toBe("Hello!");
    });

    it("should broadcast to team members", () => {
      const tm = bash.services.teamManager;
      tm.createTeam({ name: "devs", agents: ["a1", "a2", "a3"] });

      const sent = tm.broadcast("a1", "devs", "Meeting in 5");
      expect(sent).toHaveLength(2);
      expect(tm.getInbox("a2")).toHaveLength(1);
      expect(tm.getInbox("a1")).toHaveLength(0);
    });
  });

  describe("AgentMemory Service", () => {
    it("should write and read memories", () => {
      const mem = bash.services.agentMemory;
      mem.write("code-reviewer", "project", "style", "Use tabs");
      const entry = mem.read("code-reviewer", "project", "style");
      expect(entry?.value).toBe("Use tabs");
    });

    it("should list memories by agent type", () => {
      const mem = bash.services.agentMemory;
      mem.write("reviewer", "project", "a", "1");
      mem.write("reviewer", "project", "b", "2");
      mem.write("tester", "project", "c", "3");

      expect(mem.list("reviewer")).toHaveLength(2);
      expect(mem.list("tester")).toHaveLength(1);
    });

    it("should update existing memories", () => {
      const mem = bash.services.agentMemory;
      const e1 = mem.write("agent", "local", "k", "v1");
      const e2 = mem.write("agent", "local", "k", "v2");
      expect(e2.value).toBe("v2");
      expect(e2.createdAt).toBe(e1.createdAt);
    });
  });

  describe("ag-task Shell Command", () => {
    it("should create and list tasks via shell", async () => {
      let r = await bash.exec('ag-task create "Build feature"');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Created task");

      r = await bash.exec("ag-task list");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Build feature");
    });

    it("should update task status via shell", async () => {
      await bash.exec('ag-task create "Test task"');
      const r = await bash.exec("ag-task update task_1 --status in_progress");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("in_progress");
    });

    it("should show task details via get", async () => {
      await bash.exec('ag-task create "Detail task" --desc "Full description"');
      const r = await bash.exec("ag-task get task_1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Detail task");
    });
  });

  describe("ag-team Shell Command", () => {
    it("should create and list teams", async () => {
      let r = await bash.exec('ag-team create alpha --desc "Alpha team"');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Created team");

      r = await bash.exec("ag-team list");
      expect(r.stdout).toContain("alpha");
    });

    it("should add agents and delete teams", async () => {
      await bash.exec("ag-team create beta");
      let r = await bash.exec("ag-team add beta agent1");
      expect(r.exitCode).toBe(0);

      r = await bash.exec("ag-team delete beta");
      expect(r.exitCode).toBe(0);

      r = await bash.exec("ag-team list");
      expect(r.stdout).toContain("No teams");
    });
  });

  describe("ag-message Shell Command", () => {
    it("should send and read messages", async () => {
      let r = await bash.exec("ag-message send alice bob Hello Bob!");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("alice -> bob");

      r = await bash.exec("ag-message inbox bob");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("alice: Hello Bob!");
    });

    it("should broadcast to team", async () => {
      await bash.exec("ag-team create devs");
      await bash.exec("ag-team add devs a1");
      await bash.exec("ag-team add devs a2");
      await bash.exec("ag-team add devs a3");

      const r = await bash.exec("ag-message broadcast a1 devs Stand up time!");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("2 agent(s)");
    });
  });

  describe("Toolbox Tools", () => {
    it("should have all 10 Phase 1 tools registered", () => {
      const tools = bash.toolbox.getTools();
      const phase1Names = [
        "task_create",
        "task_update",
        "task_list",
        "task_get",
        "task_stop",
        "team_create",
        "team_delete",
        "send_message",
        "agent_memory_read",
        "agent_memory_write",
      ];
      for (const name of phase1Names) {
        expect(tools.find((t) => t.name === name)).toBeDefined();
      }
    });

    it("should run task_create via toolbox", async () => {
      const result = await bash.toolbox.callTool(bash, "task_create", {
        subject: "Toolbox test",
        description: "Created via toolbox",
      });
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("status", "pending");
    });

    it("should run send_message via toolbox", async () => {
      const result = await bash.toolbox.callTool(bash, "send_message", {
        from: "bot1",
        to: "bot2",
        content: "Sync complete",
      });
      expect(result).toHaveProperty("id");
    });

    it("should run agent_memory_write and read via toolbox", async () => {
      await bash.toolbox.callTool(bash, "agent_memory_write", {
        agentType: "reviewer",
        scope: "project",
        key: "preference",
        value: "strict",
      });

      const result = await bash.toolbox.callTool(bash, "agent_memory_read", {
        agentType: "reviewer",
        scope: "project",
        key: "preference",
      });
      expect(result).toHaveProperty("value", "strict");
    });
  });
});
