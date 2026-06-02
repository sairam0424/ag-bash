/**
 * ExecutionPipeline parallel-run EQUIVALENCE HARNESS.
 *
 * This file proves byte-for-byte equivalence between the two execution
 * engines wired into Bash.exec():
 *   - execMode: "monolith" — the historical inline Bash.exec() body.
 *   - execMode: "pipeline" — the composable ExecutionPipeline (normalize →
 *     parse → transform → sandbox → interpret → persist + error categorization).
 *
 * Mechanics (per the P2.1 parity map / harnessPlan):
 *   1. For each corpus case, construct TWO FRESH Bash instances from the SAME
 *      options object (so this.state starts identical). NEVER reuse one
 *      instance for both modes — state would cross-contaminate.
 *   2. Run the script (or sequence) once with execMode:"monolith" and once with
 *      execMode:"pipeline".
 *   3. Deep-equal the full BashExecResult: stdout/stderr (EXACT bytes — catches
 *      the decodeBinaryToUtf8 gap), exitCode, env (key-order-insensitive),
 *      observations, metadata.
 *   4. Surface the historically-missing pipeline error catch by failing loudly
 *      if the pipeline THROWS where the monolith returned a structured result.
 *
 * .test.ts files are exempt from the banned-pattern rules (plain objects ok).
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ScriptNode } from "../ast/types.js";
import type { BashOptions, ExecOptions } from "../Bash.js";
import { Bash } from "../Bash.js";
import { DefenseInDepthBox } from "../security/defense-in-depth-box.js";
import type { TransformPlugin } from "../transform/types.js";
import type { BashExecResult } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a result for deep-equality, dropping non-comparable internals. */
function snapshotResult(r: BashExecResult): Record<string, unknown> {
  return {
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
    // env compared as a plain object (key order is irrelevant to toEqual).
    env: { ...r.env },
    observations: r.observations ?? null,
    metadata: r.metadata ?? null,
    stdoutEncoding: r.stdoutEncoding ?? null,
  };
}

/**
 * A single step in a corpus case: a script + per-call options. Multiple steps
 * model persistence/state across exec() calls on the SAME instance.
 */
interface Step {
  script: string;
  options?: Omit<ExecOptions, "execMode">;
}

interface Case {
  name: string;
  /** Bash constructor options (identical for both engines). */
  bashOptions?: BashOptions;
  /** Sequence of exec() calls. The FINAL result is compared. */
  steps: Step[];
  /** Optional per-instance setup (e.g. register a transform plugin). */
  setup?: (bash: Bash) => void;
}

/**
 * Run one case end-to-end under a single engine and return the FINAL result.
 * A fresh Bash instance is built so state starts identical to the other engine.
 */
async function runCase(
  c: Case,
  execMode: "monolith" | "pipeline",
): Promise<BashExecResult> {
  // Reset the defense-in-depth singleton so cases with differing
  // defenseInDepth configs don't trip the config-conflict guard.
  DefenseInDepthBox.resetInstance();
  const bash = new Bash(c.bashOptions);
  c.setup?.(bash);
  let last: BashExecResult = {
    stdout: "",
    stderr: "",
    exitCode: 0,
    env: {},
  };
  for (const step of c.steps) {
    last = await bash.exec(step.script, { ...step.options, execMode });
  }
  return last;
}

/**
 * A transform plugin that prepends a marker observation via metadata and
 * leaves the AST untouched. Exercises the transform stage + null-proto merge.
 */
const markerPlugin: TransformPlugin = {
  name: "marker",
  transform({ ast }: { ast: ScriptNode }) {
    return { ast, metadata: { marker: "applied", count: 1 } };
  },
};

// ---------------------------------------------------------------------------
// Corpus — MUST cover every gap from the P2.1 parity map.
// ---------------------------------------------------------------------------

const corpus: Case[] = [
  // --- Plain happy paths ---
  { name: "plain echo", steps: [{ script: "echo hello" }] },
  {
    name: "multi-line indented",
    steps: [{ script: "\n        echo a\n        echo b\n      " }],
  },
  { name: "pipeline + cat", steps: [{ script: 'echo "hi there" | cat' }] },
  { name: "semicolon list", steps: [{ script: "echo one; echo two" }] },
  { name: "subshell", steps: [{ script: "(echo sub)" }] },
  { name: "stderr redirect", steps: [{ script: "echo err >&2" }] },
  {
    name: "var assign + subst",
    steps: [{ script: 'X=42; echo "val=$X"' }],
  },
  { name: "command substitution", steps: [{ script: "echo $(echo nested)" }] },
  {
    name: "for loop",
    steps: [{ script: "for i in 1 2 3; do echo $i; done" }],
  },
  {
    name: "function def + call",
    steps: [{ script: 'greet() { echo "hi $1"; }\ngreet world' }],
  },

  // --- UTF-8 / multibyte (catches decodeBinaryToUtf8 gap) ---
  { name: "utf8 CJK", steps: [{ script: "echo 你好世界" }] },
  { name: "utf8 emoji", steps: [{ script: "echo 🚀✨🔥" }] },
  { name: "utf8 cyrillic", steps: [{ script: "printf 'Привет\\n'" }] },
  {
    name: "utf8 mixed via var",
    steps: [{ script: 'NAME="café"; echo "héllo $NAME"' }],
  },

  // --- Empty / whitespace short-circuit ---
  { name: "empty script", steps: [{ script: "" }] },
  { name: "whitespace only", steps: [{ script: "   \n\t\n  " }] },
  {
    name: "empty with cwd",
    bashOptions: { files: { "/work/keep.txt": "x" } },
    steps: [{ script: "", options: { cwd: "/work" } }],
  },

  // --- Heredocs ---
  {
    name: "heredoc EOF",
    steps: [{ script: "cat <<EOF\nline1\nline2\nEOF" }],
  },
  {
    name: "heredoc dash strip",
    steps: [{ script: "cat <<-EOF\n\tindented\nEOF" }],
  },
  {
    name: "heredoc quoted delim",
    steps: [{ script: "cat <<'EOF'\nno $expansion here\nEOF" }],
  },

  // --- cwd / realpath / PWD / env merge / replaceEnv ---
  {
    name: "cwd option pwd",
    bashOptions: { files: { "/proj/a.txt": "1" } },
    steps: [{ script: "pwd", options: { cwd: "/proj" } }],
  },
  {
    name: "options.env merge",
    steps: [{ script: "echo $FOO", options: { env: { FOO: "barval" } } }],
  },
  {
    name: "replaceEnv true",
    bashOptions: { env: { ORIG: "original" } },
    steps: [
      {
        script: "echo ${ORIG:-gone} ${ONLY:-x}",
        options: { replaceEnv: true, env: { ONLY: "set" } },
      },
    ],
  },
  {
    name: "cwd with explicit PWD in env",
    bashOptions: { files: { "/proj/a.txt": "1" } },
    steps: [
      {
        script: "echo $PWD",
        options: { cwd: "/proj", env: { PWD: "/custom/pwd" } },
      },
    ],
  },

  // --- AST cache repeat (same script twice on one instance) ---
  {
    name: "ast cache repeat",
    steps: [{ script: "echo cached" }, { script: "echo cached" }],
  },

  // --- Transform plugin registered ---
  {
    name: "transform plugin metadata",
    setup: (bash) => bash.registerTransformPlugin(markerPlugin),
    steps: [{ script: "echo transformed" }],
  },

  // --- Defense-in-depth on / off ---
  {
    name: "defenseInDepth true",
    bashOptions: { security: { defenseInDepth: true } },
    steps: [{ script: "echo guarded" }],
  },
  {
    name: "defenseInDepth false",
    bashOptions: { security: { defenseInDepth: false } },
    steps: [{ script: "echo unguarded" }],
  },

  // --- Error classes ---
  { name: "syntax error (parse)", steps: [{ script: "if then fi" }] },
  {
    name: "lexer error unterminated quote",
    steps: [{ script: 'echo "unterminated' }],
  },
  { name: "arithmetic div by zero", steps: [{ script: "echo $((1/0))" }] },
  { name: "exit builtin code 7", steps: [{ script: "exit 7" }] },
  { name: "exit builtin code 0", steps: [{ script: "exit 0" }] },
  { name: "command not found 127", steps: [{ script: "nonexistent_cmd_xyz" }] },
  {
    name: "PosixFatalError (posix shift)",
    steps: [{ script: "set -o posix; shift 3" }],
  },
  {
    name: "abort signal pre-aborted",
    steps: [
      {
        script: "echo should-not-run",
        options: (() => {
          const c = new AbortController();
          c.abort();
          return { signal: c.signal };
        })(),
      },
    ],
  },
  {
    name: "ExecutionLimit low maxCommandCount",
    bashOptions: { executionLimits: { maxCommandCount: 3 } },
    steps: [{ script: "for i in 1 2 3 4 5 6 7 8; do echo $i; done" }],
  },

  // --- Error AFTER mutation (catches error-env-source gap) ---
  {
    name: "export then arithmetic error",
    steps: [{ script: "export MUT=1; echo $((1/0))" }],
  },
  {
    name: "export then exit nonzero",
    steps: [{ script: "export MUT2=1; exit 5" }],
  },

  // --- Persistence across two execs ---
  {
    name: "persist export across execs",
    bashOptions: { persistState: true },
    steps: [
      { script: "export PVAR=persisted" },
      { script: "echo ${PVAR:-missing}" },
    ],
  },
  {
    name: "no-persist export across execs",
    bashOptions: { persistState: false },
    steps: [
      { script: "export EVAR=ephemeral" },
      { script: "echo ${EVAR:-missing}" },
    ],
  },
  {
    name: "persist blocked on failure",
    bashOptions: { persistState: true },
    steps: [
      { script: "export FVAR=x; false" },
      { script: "echo ${FVAR:-missing}" },
    ],
  },
  {
    name: "persist cd across execs",
    bashOptions: {
      persistState: true,
      files: { "/sub/f.txt": "1" },
    },
    steps: [{ script: "cd /sub" }, { script: "pwd" }],
  },
  {
    name: "persist function across execs",
    bashOptions: { persistState: true },
    steps: [{ script: "myfn() { echo fnbody; }" }, { script: "myfn" }],
  },

  // --- env in result reflects assignments ---
  {
    name: "export visible in result env",
    steps: [{ script: "export RESVAR=hello" }],
  },
];

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

describe("ExecutionPipeline parity (monolith vs pipeline)", () => {
  afterEach(() => {
    DefenseInDepthBox.resetInstance();
  });

  for (const c of corpus) {
    it(`byte-equal: ${c.name}`, async () => {
      const monolith = await runCase(c, "monolith");

      let pipeline: BashExecResult;
      try {
        pipeline = await runCase(c, "pipeline");
      } catch (err) {
        // The pipeline must NEVER throw where the monolith returned a result.
        // (Historically run() had no catch and would throw on ExitError etc.)
        throw new Error(
          `pipeline THREW for case "${c.name}" but monolith returned ` +
            `exitCode=${monolith.exitCode}. Error: ${String(err)}`,
        );
      }

      expect(snapshotResult(pipeline)).toEqual(snapshotResult(monolith));
    });
  }

  it("ran the full parity corpus", () => {
    // Sentinel: makes the corpus size visible in the test report.
    expect(corpus.length).toBeGreaterThanOrEqual(40);
  });
});
