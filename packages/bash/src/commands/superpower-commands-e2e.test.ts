/**
 * End-to-end integration tests for the 6 superpower shell commands.
 *
 * Each command is exercised through bash.execute() with a real Bash instance
 * backed by InMemoryFs + agentic: { enabled: true }.
 *
 * Commands under test:
 *   ag-task, ag-team, ag-message, ag-glob, ag-cron, ag-worktree
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";

let bash: Bash;

beforeEach(() => {
  bash = new Bash({ fs: new InMemoryFs(), agentic: { enabled: true } });
});

/** Extract a task_N or cron_N id from command output. */
function extractId(output: string, prefix: string): string {
  const match = output.match(new RegExp(`(${prefix}_\\d+)`));
  if (!match) throw new Error(`No ${prefix}_N id found in: ${output}`);
  return match[1];
}

// ────────────────────────────────────────────────────────────────────
// ag-task
// ────────────────────────────────────────────────────────────────────
describe("ag-task", () => {
  it("--help returns usage information", async () => {
    const r = await bash.exec("ag-task --help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ag-task");
    expect(r.stdout).toContain("create");
    expect(r.stdout).toContain("list");
    expect(r.stdout).toContain("get");
    expect(r.stdout).toContain("update");
    expect(r.stdout).toContain("stop");
  });

  it("create produces a task with a task_ id", async () => {
    const r = await bash.exec('ag-task create "Implement login"');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Created task");
    expect(r.stdout).toContain("Implement login");
    expect(r.stdout).toMatch(/task_\d+/);
  });

  it("create with --desc flag", async () => {
    const r = await bash.exec(
      'ag-task create "Deploy" --desc "Deploy to production"',
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Created task");
    expect(r.stdout).toContain("Deploy");
  });

  it("create fails when subject is missing", async () => {
    const r = await bash.exec("ag-task create");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing task subject");
  });

  it("list shows created tasks", async () => {
    await bash.exec('ag-task create "Alpha"');
    await bash.exec('ag-task create "Bravo"');
    const r = await bash.exec("ag-task list");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Alpha");
    expect(r.stdout).toContain("Bravo");
    expect(r.stdout).toContain("Tasks:");
  });

  it("list returns empty message when no tasks", async () => {
    const r = await bash.exec("ag-task list");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No tasks");
  });

  it("get shows task details", async () => {
    const cr = await bash.exec(
      'ag-task create "Review PR" --desc "Review pull request #42"',
    );
    const taskId = extractId(cr.stdout, "task");
    const r = await bash.exec(`ag-task get ${taskId}`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Review PR");
    expect(r.stdout).toContain("Review pull request #42");
    expect(r.stdout).toContain("Status:");
    expect(r.stdout).toContain("pending");
  });

  it("get fails for nonexistent task", async () => {
    const r = await bash.exec("ag-task get task_999");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not found");
  });

  it("update changes task status", async () => {
    const cr = await bash.exec('ag-task create "Write tests"');
    const taskId = extractId(cr.stdout, "task");
    const r = await bash.exec(`ag-task update ${taskId} --status in_progress`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Updated task");
    expect(r.stdout).toContain("in_progress");
  });

  it("update rejects invalid status transition", async () => {
    const cr = await bash.exec('ag-task create "Setup CI"');
    const taskId = extractId(cr.stdout, "task");
    await bash.exec(`ag-task update ${taskId} --status in_progress`);
    const r = await bash.exec(`ag-task update ${taskId} --status pending`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Invalid transition");
  });

  it("stop marks the task as failed", async () => {
    const cr = await bash.exec('ag-task create "Long process"');
    const taskId = extractId(cr.stdout, "task");
    const r = await bash.exec(`ag-task stop ${taskId}`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Stopped task");

    // Verify the status was set to failed
    const detail = await bash.exec(`ag-task get ${taskId}`);
    expect(detail.stdout).toContain("failed");
  });

  it("stop fails for nonexistent task", async () => {
    const r = await bash.exec("ag-task stop task_999");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────
// ag-team
// ────────────────────────────────────────────────────────────────────
describe("ag-team", () => {
  it("--help returns usage information", async () => {
    const r = await bash.exec("ag-team --help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ag-team");
    expect(r.stdout).toContain("create");
    expect(r.stdout).toContain("delete");
    expect(r.stdout).toContain("list");
    expect(r.stdout).toContain("add");
    expect(r.stdout).toContain("remove");
  });

  it("create builds a new team", async () => {
    const r = await bash.exec(
      'ag-team create frontend --desc "Frontend squad"',
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Created team");
    expect(r.stdout).toContain("frontend");
  });

  it("create fails on duplicate team name", async () => {
    await bash.exec("ag-team create backend");
    const r = await bash.exec("ag-team create backend");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("already exists");
  });

  it("list shows all teams", async () => {
    await bash.exec("ag-team create alpha");
    await bash.exec("ag-team create bravo");
    const r = await bash.exec("ag-team list");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("alpha");
    expect(r.stdout).toContain("bravo");
    expect(r.stdout).toContain("Teams:");
  });

  it("list shows empty state when no teams", async () => {
    const r = await bash.exec("ag-team list");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No teams");
  });

  it("add agent to team", async () => {
    await bash.exec("ag-team create devs");
    const r = await bash.exec("ag-team add devs agent-alpha");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Added agent-alpha to team devs");
  });

  it("remove agent from team", async () => {
    await bash.exec("ag-team create devs");
    await bash.exec("ag-team add devs agent-alpha");
    await bash.exec("ag-team add devs agent-beta");
    const r = await bash.exec("ag-team remove devs agent-alpha");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Removed agent-alpha from team devs");
  });

  it("delete removes a team", async () => {
    await bash.exec("ag-team create temp");
    const r = await bash.exec("ag-team delete temp");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Deleted team temp");

    // Confirm it is gone
    const list = await bash.exec("ag-team list");
    expect(list.stdout).toContain("No teams");
  });

  it("delete fails for nonexistent team", async () => {
    const r = await bash.exec("ag-team delete ghost");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not found");
  });
});

// ────────────────────────────────────────────────────────────────────
// ag-message
// ────────────────────────────────────────────────────────────────────
describe("ag-message", () => {
  it("send delivers a message between agents", async () => {
    const r = await bash.exec("ag-message send alice bob Hello Bob!");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("alice -> bob");
  });

  it("inbox shows received messages", async () => {
    await bash.exec("ag-message send alice bob Ping");
    await bash.exec("ag-message send charlie bob Pong");
    const r = await bash.exec("ag-message inbox bob");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("alice: Ping");
    expect(r.stdout).toContain("charlie: Pong");
    expect(r.stdout).toContain("2 messages");
  });

  it("inbox returns empty when no messages", async () => {
    const r = await bash.exec("ag-message inbox lonely");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No messages");
  });

  it("broadcast sends to all team members except sender", async () => {
    // Create a team with 3 agents
    await bash.exec("ag-team create ops");
    await bash.exec("ag-team add ops a1");
    await bash.exec("ag-team add ops a2");
    await bash.exec("ag-team add ops a3");

    const r = await bash.exec("ag-message broadcast a1 ops Deploy ready!");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("2 agent(s)");

    // Verify recipients received the message
    const a2Inbox = await bash.exec("ag-message inbox a2");
    expect(a2Inbox.stdout).toContain("Deploy ready!");

    const a3Inbox = await bash.exec("ag-message inbox a3");
    expect(a3Inbox.stdout).toContain("Deploy ready!");

    // Sender should not have received their own broadcast
    const a1Inbox = await bash.exec("ag-message inbox a1");
    expect(a1Inbox.stdout).toContain("No messages");
  });

  it("send fails with missing arguments", async () => {
    const r = await bash.exec("ag-message send alice");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Usage");
  });

  it("broadcast fails with missing arguments", async () => {
    const r = await bash.exec("ag-message broadcast a1");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Usage");
  });

  it("no subcommand returns usage error", async () => {
    const r = await bash.exec("ag-message");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Usage");
  });
});

// ────────────────────────────────────────────────────────────────────
// ag-glob
// ────────────────────────────────────────────────────────────────────
describe("ag-glob", () => {
  beforeEach(async () => {
    // Seed the VFS with some files for glob matching
    await bash.fs.mkdir("/project/src", { recursive: true });
    await bash.fs.mkdir("/project/docs", { recursive: true });
    await bash.fs.writeFile("/project/src/index.ts", "export {};");
    await bash.fs.writeFile("/project/src/utils.ts", "export {};");
    await bash.fs.writeFile("/project/src/helper.js", "module.exports = {};");
    await bash.fs.writeFile("/project/docs/readme.txt", "Hello");
    await bash.fs.writeFile("/project/docs/notes.txt", "Notes");
    await bash.fs.writeFile("/project/docs/guide.md", "# Guide");
  });

  it("--help returns usage information", async () => {
    const r = await bash.exec("ag-glob --help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ag-glob");
    expect(r.stdout).toContain("pattern");
    expect(r.stdout).toContain("--limit");
  });

  it("matches *.txt files", async () => {
    const r = await bash.exec('ag-glob "*.txt" --path /project/docs');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("readme.txt");
    expect(r.stdout).toContain("notes.txt");
    expect(r.stdout).not.toContain("guide.md");
  });

  it("matches *.ts files recursively with **", async () => {
    const r = await bash.exec('ag-glob "**/*.ts" --path /project');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("index.ts");
    expect(r.stdout).toContain("utils.ts");
    expect(r.stdout).not.toContain("helper.js");
  });

  it("--limit caps the number of results", async () => {
    const r = await bash.exec('ag-glob "**/*" --path /project --limit 2');
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines.length).toBe(2);
  });

  it("returns no matches message for unmatched pattern", async () => {
    const r = await bash.exec('ag-glob "*.py" --path /project');
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("No matching files");
    expect(r.stdout).toBe("");
  });

  it("fails when no pattern is given", async () => {
    const r = await bash.exec("ag-glob");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Usage");
  });
});

// ────────────────────────────────────────────────────────────────────
// ag-cron
// ────────────────────────────────────────────────────────────────────
describe("ag-cron", () => {
  it("--help returns usage information", async () => {
    const r = await bash.exec("ag-cron --help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ag-cron");
    expect(r.stdout).toContain("create");
    expect(r.stdout).toContain("delete");
    expect(r.stdout).toContain("list");
    expect(r.stdout).toContain("--one-shot");
    expect(r.stdout).toContain("--durable");
  });

  it("create a recurring cron job", async () => {
    const r = await bash.exec(
      'ag-cron create "*/5 * * * *" "echo health check"',
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Created recurring job");
    expect(r.stdout).toContain("*/5 * * * *");
    expect(r.stdout).toContain("echo health check");
    expect(r.stdout).toMatch(/cron_\d+/);
  });

  it("create a one-shot cron job", async () => {
    const r = await bash.exec(
      'ag-cron create "0 9 * * 1" "run report" --one-shot',
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Created one-shot job");
    expect(r.stdout).toContain("run report");
  });

  it("list shows created jobs", async () => {
    await bash.exec('ag-cron create "0 * * * *" "job-a"');
    await bash.exec('ag-cron create "30 2 * * *" "job-b" --one-shot');
    const r = await bash.exec("ag-cron list");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Cron jobs:");
    expect(r.stdout).toContain("job-a");
    expect(r.stdout).toContain("job-b");
    expect(r.stdout).toContain("recurring");
    expect(r.stdout).toContain("one-shot");
  });

  it("list returns empty message when no jobs", async () => {
    const r = await bash.exec("ag-cron list");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No cron jobs");
  });

  it("delete removes a job by id", async () => {
    const cr = await bash.exec('ag-cron create "0 * * * *" "temp-job"');
    const cronId = extractId(cr.stdout, "cron");
    // Verify the job exists
    const listBefore = await bash.exec("ag-cron list");
    expect(listBefore.stdout).toContain("temp-job");

    const r = await bash.exec(`ag-cron delete ${cronId}`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`Deleted job ${cronId}`);

    const listAfter = await bash.exec("ag-cron list");
    expect(listAfter.stdout).toContain("No cron jobs");
  });

  it("delete fails for nonexistent job", async () => {
    const r = await bash.exec("ag-cron delete cron_999");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not found");
  });

  it("create fails with invalid cron expression", async () => {
    const r = await bash.exec('ag-cron create "bad" "do something"');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Invalid cron expression");
  });

  it("create fails when prompt is missing", async () => {
    const r = await bash.exec('ag-cron create "* * * * *"');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing prompt");
  });
});

// ────────────────────────────────────────────────────────────────────
// ag-worktree
// ────────────────────────────────────────────────────────────────────
describe("ag-worktree", () => {
  it("--help returns usage information", async () => {
    const r = await bash.exec("ag-worktree --help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ag-worktree");
    expect(r.stdout).toContain("enter");
    expect(r.stdout).toContain("exit");
    expect(r.stdout).toContain("list");
    expect(r.stdout).toContain("delete");
  });

  it("enter creates and enters a worktree", async () => {
    const r = await bash.exec("ag-worktree enter my-feature");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Entered worktree "my-feature"');
    expect(r.stdout).toContain("/.ag-bash/worktrees/my-feature");
    expect(r.stdout).toContain("worktree/my-feature");
  });

  it("enter with --branch flag", async () => {
    const r = await bash.exec(
      "ag-worktree enter hotfix --branch fix/login-bug",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Entered worktree "hotfix"');
    expect(r.stdout).toContain("fix/login-bug");
  });

  it("list shows active worktree with asterisk indicator", async () => {
    await bash.exec("ag-worktree enter feature-a");
    const r = await bash.exec("ag-worktree list");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("feature-a");
    expect(r.stdout).toContain("*");
    expect(r.stdout).toContain("Worktrees:");
  });

  it("list returns empty message when no worktrees", async () => {
    const r = await bash.exec("ag-worktree list");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No worktrees");
  });

  it("exit leaves the active worktree", async () => {
    await bash.exec("ag-worktree enter temp-work");
    const r = await bash.exec("ag-worktree exit");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Exited worktree");
    expect(r.stdout).toContain("Restored cwd");
  });

  it("exit fails when no worktree is active", async () => {
    const r = await bash.exec("ag-worktree exit");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no active worktree");
  });

  it("delete removes a worktree", async () => {
    await bash.exec("ag-worktree enter disposable");
    await bash.exec("ag-worktree exit");
    const r = await bash.exec("ag-worktree delete disposable");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Deleted worktree "disposable"');

    const list = await bash.exec("ag-worktree list");
    expect(list.stdout).toContain("No worktrees");
  });

  it("delete fails for nonexistent worktree", async () => {
    const r = await bash.exec("ag-worktree delete ghost");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not found");
  });

  it("enter the same worktree twice re-enters without error", async () => {
    await bash.exec("ag-worktree enter reusable");
    await bash.exec("ag-worktree exit");
    const r = await bash.exec("ag-worktree enter reusable");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Entered worktree "reusable"');
  });
});
