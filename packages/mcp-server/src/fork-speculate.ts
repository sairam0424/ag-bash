import type { Bash } from "@ag-bash/bash";
import type { McpToolResult } from "./tool-bridge.js";

/** Upper bound on parallel branches per fork_speculate call. */
const MAX_BRANCHES = 16;
/** Upper bound on scripts executed within a single branch. */
const MAX_SCRIPTS_PER_BRANCH = 64;

/** Per-branch execution result reported back to the agent. */
export interface BranchResult {
  index: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Aggregate fork_speculate summary. */
export interface ForkSpeculateSummary {
  branches: BranchResult[];
  /** Index of the branch committed onto the persistent shell, or null. */
  committed: number | null;
}

/**
 * Run a single speculation branch: execute its scripts in order inside an
 * isolated fork and collect the combined output + exit code. Stops early on the
 * first non-zero exit so the agent can see where the branch broke.
 */
async function runBranch(
  branch: Bash,
  scripts: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  for (const script of scripts) {
    const r = await branch.exec(script, { persistState: true });
    if (r.stdout) stdout += r.stdout;
    if (r.stderr) stderr += r.stderr;
    exitCode = r.exitCode;
    if (exitCode !== 0) break;
  }
  return { stdout, stderr, exitCode };
}

/**
 * fork_speculate native MCP tool implementation.
 *
 * Forks N isolated copy-on-write branches from `parent`, runs each candidate
 * script sequence in parallel, and reports per-branch output + exit codes so an
 * agent can pick a winner. Branch mutations (env, cwd, files) are invisible to
 * the persistent shell and to each other. When `keepWinner` is a valid branch
 * index, that branch's scripts are re-executed on `parent` to commit its
 * effect; otherwise the persistent shell is left untouched.
 *
 * @param parent - The persistent shell to fork from (and optionally commit to).
 * @param args - Raw JSON-RPC tool arguments: `{ branches, keepWinner? }`.
 */
export async function runForkSpeculate(
  parent: Bash,
  args: unknown,
): Promise<McpToolResult> {
  const a = (args ?? Object.create(null)) as {
    branches?: unknown;
    keepWinner?: unknown;
  };

  const rawBranches = Array.isArray(a.branches) ? a.branches : [];
  if (rawBranches.length === 0) {
    return {
      content: [
        { type: "text", text: "Error: 'branches' must be a non-empty array." },
      ],
      isError: true,
    };
  }
  if (rawBranches.length > MAX_BRANCHES) {
    return {
      content: [
        {
          type: "text",
          text: `Error: too many branches (max ${MAX_BRANCHES}).`,
        },
      ],
      isError: true,
    };
  }

  // Normalize each branch into a bounded array of string scripts.
  const branchScripts: string[][] = rawBranches.map((b: unknown) => {
    const scripts = Array.isArray(b) ? b : [b];
    return scripts
      .slice(0, MAX_SCRIPTS_PER_BRANCH)
      .map((s: unknown) => String(s ?? ""));
  });

  // Fork isolated children and run candidates in parallel.
  const forks = await Promise.all(branchScripts.map(() => parent.fork()));
  const results = await Promise.all(
    branchScripts.map((scripts, i) => runBranch(forks[i], scripts)),
  );

  // Optionally commit a winning branch onto the persistent shell.
  let committed: number | null = null;
  const keepWinner = a.keepWinner;
  if (typeof keepWinner === "number") {
    if (keepWinner < 0 || keepWinner >= branchScripts.length) {
      return {
        content: [
          { type: "text", text: "Error: keepWinner index out of range." },
        ],
        isError: true,
      };
    }
    for (const script of branchScripts[keepWinner]) {
      await parent.exec(script, { persistState: true });
    }
    committed = keepWinner;
  }

  const summary: ForkSpeculateSummary = {
    branches: results.map((r, i) => ({
      index: i,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
    })),
    committed,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
  };
}
