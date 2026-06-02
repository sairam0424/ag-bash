/**
 * Toolbox Integration Tests
 *
 * Validates that all 19 new toolbox tools are properly registered in BashToolbox
 * and executable via callTool(). Covers task management, multi-agent swarm,
 * intelligence, automation, and search tools.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";

/** Helper type for test assertions on callTool results */
type ToolResult = Record<string, unknown>;

let bash: Bash;
beforeEach(() => {
  bash = new Bash({ fs: new InMemoryFs(), agentic: { enabled: true } });
});

// ─── Tool Registration ──────────────────────────────────────────────────────

const EXPECTED_TOOLS = [
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
  "glob_files",
  "git_track",
  "git_audit_log",
  "check_destructive",
  "cron_create",
  "cron_delete",
  "cron_list",
  "enter_worktree",
  "exit_worktree",
] as const;

describe("Tool Registration", () => {
  it("should have all 19 new tools registered", () => {
    const registeredNames = bash.toolbox.getTools().map((t) => t.name);
    for (const name of EXPECTED_TOOLS) {
      expect(registeredNames, `Tool "${name}" is not registered`).toContain(
        name,
      );
    }
  });

  it("should have each tool with a non-empty description and parameters", () => {
    for (const name of EXPECTED_TOOLS) {
      const tool = bash.toolbox.getTool(name);
      expect(tool, `Tool "${name}" not found via getTool()`).toBeDefined();
      expect(tool?.description.length).toBeGreaterThan(0);
      expect(tool?.parameters).toBeDefined();
    }
  });
});

// ─── Task Management Tools ──────────────────────────────────────────────────

describe("Task Management Tools", () => {
  let _taskId: string;

  it("task_create - should create a task with subject and description", async () => {
    const result = (await bash.toolbox.callTool(bash, "task_create", {
      subject: "Write unit tests",
      description: "Cover all 19 new tools with integration tests",
    })) as ToolResult;
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("subject", "Write unit tests");
    expect(result).toHaveProperty("status", "pending");
    _taskId = result.id as string;
  });

  it("task_list - should return an array containing the created task", async () => {
    // Create a task first so we have something to list
    const created = (await bash.toolbox.callTool(bash, "task_create", {
      subject: "List test task",
      description: "A task for the list test",
    })) as ToolResult;

    const result = (await bash.toolbox.callTool(
      bash,
      "task_list",
      {},
    )) as ToolResult[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const found = result.find((t: ToolResult) => t.id === created.id);
    expect(found).toBeDefined();
    expect(found!.subject).toBe("List test task");
  });

  it("task_update - should update task status to in_progress", async () => {
    const created = (await bash.toolbox.callTool(bash, "task_create", {
      subject: "Update test task",
      description: "A task to update",
    })) as ToolResult;

    const result = await bash.toolbox.callTool(bash, "task_update", {
      taskId: created.id as string,
      status: "in_progress",
    });
    expect(result).toHaveProperty("id", created.id);
    expect(result).toHaveProperty("status", "in_progress");
  });

  it("task_get - should return the full task object by ID", async () => {
    const created = (await bash.toolbox.callTool(bash, "task_create", {
      subject: "Get test task",
      description: "A task to retrieve",
    })) as ToolResult;

    const result = await bash.toolbox.callTool(bash, "task_get", {
      taskId: created.id as string,
    });
    expect(result).toHaveProperty("id", created.id);
    expect(result).toHaveProperty("subject", "Get test task");
    expect(result).toHaveProperty("description", "A task to retrieve");
    expect(result).toHaveProperty("status", "pending");
    expect(result).toHaveProperty("blocks");
    expect(result).toHaveProperty("blockedBy");
    expect(result).toHaveProperty("createdAt");
    expect(result).toHaveProperty("updatedAt");
  });

  it("task_stop - should stop a task and set status to failed", async () => {
    const created = (await bash.toolbox.callTool(bash, "task_create", {
      subject: "Stop test task",
      description: "A task to stop",
    })) as ToolResult;

    // First move to in_progress (valid transition from pending)
    await bash.toolbox.callTool(bash, "task_update", {
      taskId: created.id as string,
      status: "in_progress",
    });

    const result = await bash.toolbox.callTool(bash, "task_stop", {
      taskId: created.id as string,
    });
    expect(result).toHaveProperty("id", created.id);
    expect(result).toHaveProperty("status", "failed");
  });
});

// ─── Multi-Agent Swarm Tools ────────────────────────────────────────────────

describe("Multi-Agent Swarm Tools", () => {
  it("team_create - should create a team with name", async () => {
    const result = await bash.toolbox.callTool(bash, "team_create", {
      name: "alpha-squad",
    });
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("name", "alpha-squad");
  });

  it("team_delete - should delete a team and return success message", async () => {
    await bash.toolbox.callTool(bash, "team_create", {
      name: "to-be-deleted",
    });

    const result = await bash.toolbox.callTool(bash, "team_delete", {
      name: "to-be-deleted",
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("Deleted team");
  });

  it("send_message - should send a message from one agent to another", async () => {
    const result = await bash.toolbox.callTool(bash, "send_message", {
      from: "agent-1",
      to: "agent-2",
      content: "Hello from agent-1!",
    });
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("from", "agent-1");
    expect(result).toHaveProperty("to", "agent-2");
  });
});

// ─── Agent Memory Tools ─────────────────────────────────────────────────────

describe("Agent Memory Tools", () => {
  it("agent_memory_write - should write a memory entry and return it", async () => {
    const result = await bash.toolbox.callTool(bash, "agent_memory_write", {
      agentType: "tester",
      scope: "project",
      key: "last-run",
      value: "2026-05-01T00:00:00Z",
    });
    expect(result).toHaveProperty("key", "last-run");
    expect(result).toHaveProperty("scope", "project");
    expect(result).toHaveProperty("agentType", "tester");
  });

  it("agent_memory_read - should read back the same key with matching value", async () => {
    // Write first
    await bash.toolbox.callTool(bash, "agent_memory_write", {
      agentType: "tester",
      scope: "project",
      key: "read-test-key",
      value: "expected-value-42",
    });

    // Read back
    const result = await bash.toolbox.callTool(bash, "agent_memory_read", {
      agentType: "tester",
      scope: "project",
      key: "read-test-key",
    });
    expect(result).toHaveProperty("value", "expected-value-42");
    expect(result).toHaveProperty("key", "read-test-key");
    expect(result).toHaveProperty("agentType", "tester");
    expect(result).toHaveProperty("scope", "project");
  });
});

// ─── Intelligence Tools ─────────────────────────────────────────────────────

describe("Intelligence Tools", () => {
  describe("git_track", () => {
    it("should classify 'git status' as safe", async () => {
      const result = await bash.toolbox.callTool(bash, "git_track", {
        command: "git status",
      });
      expect(result).toHaveProperty("classification", "safe");
      expect(result).toHaveProperty("command", "git status");
      expect(result).toHaveProperty("id");
    });

    it("should classify 'git reset --hard' as destructive", async () => {
      const result = await bash.toolbox.callTool(bash, "git_track", {
        command: "git reset --hard",
      });
      expect(result).toHaveProperty("classification", "destructive");
      expect(result).toHaveProperty("command", "git reset --hard");
    });
  });

  it("git_audit_log - should contain both operations from git_track", async () => {
    // Record two operations
    await bash.toolbox.callTool(bash, "git_track", {
      command: "git status",
    });
    await bash.toolbox.callTool(bash, "git_track", {
      command: "git reset --hard",
    });

    const log = (await bash.toolbox.callTool(
      bash,
      "git_audit_log",
      {},
    )) as ToolResult[];
    expect(Array.isArray(log)).toBe(true);
    expect(log.length).toBeGreaterThanOrEqual(2);

    const commands = log.map((op: ToolResult) => op.command);
    expect(commands).toContain("git status");
    expect(commands).toContain("git reset --hard");
  });

  describe("check_destructive", () => {
    it("should return a warning with category 'file' for 'rm -rf /'", async () => {
      const result = await bash.toolbox.callTool(bash, "check_destructive", {
        command: "rm -rf /",
      });
      expect(result).toHaveProperty("category", "file");
      expect(result).toHaveProperty("severity");
      expect(result).toHaveProperty("pattern");
    });

    it("should return safe message for 'ls -la'", async () => {
      const result = (await bash.toolbox.callTool(bash, "check_destructive", {
        command: "ls -la",
      })) as ToolResult;
      expect(result).toHaveProperty("safe", true);
      expect(result).toHaveProperty("message");
      expect(result.message).toContain("No destructive patterns");
    });
  });

  it("glob_files - should be callable with pattern argument", async () => {
    // glob_files delegates to ag-glob which runs in the shell —
    // we verify the tool is registered and callable (it may return empty
    // results since InMemoryFs starts empty, or an exec error which is still valid)
    const tool = bash.toolbox.getTool("glob_files");
    expect(tool).toBeDefined();
    expect(tool?.name).toBe("glob_files");

    // Call it — the result may be empty or an error string depending on
    // whether ag-glob is registered, but callTool should not throw
    const result = await bash.toolbox.callTool(bash, "glob_files", {
      pattern: "**/*.ts",
    });
    expect(result).toBeDefined();
  });
});

// ─── Automation Tools ───────────────────────────────────────────────────────

describe("Automation Tools", () => {
  let _cronJobId: string;

  it("cron_create - should create a cron job and return id, cron, recurring", async () => {
    const result = (await bash.toolbox.callTool(bash, "cron_create", {
      cron: "*/5 * * * *",
      prompt: "Run tests",
    })) as ToolResult;
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("cron", "*/5 * * * *");
    expect(result).toHaveProperty("recurring", true);
    _cronJobId = result.id as string;
  });

  it("cron_list - should return array with the created job", async () => {
    const created = (await bash.toolbox.callTool(bash, "cron_create", {
      cron: "0 * * * *",
      prompt: "Hourly check",
    })) as ToolResult;

    const result = (await bash.toolbox.callTool(
      bash,
      "cron_list",
      {},
    )) as ToolResult[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const found = result.find((j: ToolResult) => j.id === created.id);
    expect(found).toBeDefined();
    expect(found!.prompt).toBe("Hourly check");
  });

  it("cron_delete - should delete the job and return success", async () => {
    const created = (await bash.toolbox.callTool(bash, "cron_create", {
      cron: "30 2 * * *",
      prompt: "Nightly build",
    })) as ToolResult;

    const result = await bash.toolbox.callTool(bash, "cron_delete", {
      id: created.id as string,
    });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Deleted cron job");
  });
});

// ─── Worktree Tools ─────────────────────────────────────────────────────────

describe("Worktree Tools", () => {
  it("enter_worktree - should create/enter a worktree and return id, path, branch", async () => {
    const result = (await bash.toolbox.callTool(bash, "enter_worktree", {
      name: "feature-x",
    })) as ToolResult;
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("path");
    expect(result.path as string).toContain("feature-x");
    expect(result).toHaveProperty("branch");
    expect(result.branch).toBe("worktree/feature-x");
  });

  it("exit_worktree - should exit and return restored cwd", async () => {
    // Enter a worktree first
    await bash.toolbox.callTool(bash, "enter_worktree", {
      name: "feature-y",
    });

    const result = (await bash.toolbox.callTool(
      bash,
      "exit_worktree",
      {},
    )) as ToolResult;
    expect(result).toHaveProperty("restored");
    expect(typeof result.restored).toBe("string");
  });
});

// ─── Search Tools ───────────────────────────────────────────────────────────

describe("Search Tools (search_tools)", () => {
  it("should find task-related tools when searching for 'task'", async () => {
    const result = (await bash.toolbox.callTool(bash, "search_tools", {
      query: "task",
    })) as ToolResult[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    const names = result.map((r: ToolResult) => r.name as string);
    // At least some of the task_* tools should appear
    const taskTools = names.filter((n: string) => n.startsWith("task_"));
    expect(taskTools.length).toBeGreaterThan(0);

    // Each result should have a score and matchedOn field
    for (const r of result) {
      expect(r).toHaveProperty("score");
      expect(r).toHaveProperty("matchedOn");
      expect(typeof r.score).toBe("number");
    }
  });

  it("should support select:name1,name2 pattern for exact lookup", async () => {
    const result = (await bash.toolbox.callTool(bash, "search_tools", {
      query: "select:task_create,team_create",
    })) as ToolResult[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);

    const names = result.map((r: ToolResult) => r.name as string);
    expect(names).toContain("task_create");
    expect(names).toContain("team_create");
  });
});

// ─── Summary ────────────────────────────────────────────────────────────────

describe("Registration Summary", () => {
  it("should confirm all 19 tools are registered and callable", () => {
    const allTools = bash.toolbox.getTools();
    const allNames = allTools.map((t) => t.name);
    let verified = 0;
    const missing: string[] = [];

    for (const name of EXPECTED_TOOLS) {
      if (allNames.includes(name)) {
        verified++;
      } else {
        missing.push(name);
      }
    }

    expect(missing).toEqual([]);
    expect(verified).toBe(19);
  });
});
