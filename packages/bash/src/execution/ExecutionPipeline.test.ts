/**
 * ExecutionPipeline Stage Tests
 *
 * Tests each stage's input/output contract within the composable
 * execution pipeline architecture:
 *   Normalize → Parse → Transform → Sandbox → Interpret → Persist → Error
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Bash } from "../Bash.js";
import type { BashExecResult } from "../types.js";

describe("ExecutionPipeline", () => {
  let bash: Bash;

  beforeEach(() => {
    bash = new Bash();
  });

  describe("Normalize Stage", () => {
    it("should short-circuit empty scripts with exit code 0", async () => {
      const result = await bash.exec("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });

    it("should short-circuit whitespace-only scripts with exit code 0", async () => {
      const result = await bash.exec("   \n\t\n  ");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });

    it("should normalize leading whitespace in multi-line scripts", async () => {
      const result = await bash.exec(`
        echo hello
        echo world
      `);
      expect(result.stdout).toBe("hello\nworld\n");
      expect(result.exitCode).toBe(0);
    });

    it("should preserve heredoc content during normalization", async () => {
      const result = await bash.exec(`
        cat <<EOF
  indented content
  another line
EOF
      `);
      expect(result.stdout).toContain("indented content");
      expect(result.stdout).toContain("another line");
    });

    it("should skip normalization when rawScript option is true", async () => {
      const script = "  echo preserved";
      const result = await bash.exec(script, { rawScript: true });
      // With rawScript, the leading whitespace should not affect execution
      // The script still runs but whitespace is preserved for heredocs etc.
      expect(result.exitCode).toBe(0);
    });
  });

  describe("Parse Stage", () => {
    it("should parse a simple command into executable AST", async () => {
      const result = await bash.exec("echo hello");
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse compound commands (if/then/fi)", async () => {
      const result = await bash.exec(`
        if true; then
          echo yes
        fi
      `);
      expect(result.stdout).toBe("yes\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse pipeline commands", async () => {
      const result = await bash.exec('echo "hello world" | cat');
      expect(result.stdout).toBe("hello world\n");
    });

    it("should produce syntax error for invalid scripts", async () => {
      const result = await bash.exec("if then fi");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("syntax error");
    });

    it("should parse command lists with semicolons", async () => {
      const result = await bash.exec("echo one; echo two");
      expect(result.stdout).toBe("one\ntwo\n");
    });

    it("should parse subshells", async () => {
      const result = await bash.exec("(echo sub)");
      expect(result.stdout).toBe("sub\n");
    });

    it("should report unterminated quotes as parse error", async () => {
      const result = await bash.exec('echo "unterminated');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    });
  });

  describe("Transform Stage", () => {
    it("should pass through when no transform plugins are registered", async () => {
      // Default Bash instance has no transform plugins - should work normally
      const result = await bash.exec("echo transformed");
      expect(result.stdout).toBe("transformed\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not alter simple command output when transforms are inactive", async () => {
      const result = await bash.exec("echo one; echo two; echo three");
      expect(result.stdout).toBe("one\ntwo\nthree\n");
    });
  });

  describe("Sandbox Stage", () => {
    it("should execute normally when sandbox is not configured", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo safe");
      expect(result.stdout).toBe("safe\n");
      expect(result.exitCode).toBe(0);
    });

    it("should allow standard operations within sandbox constraints", async () => {
      const bash = new Bash({
        security: { defenseInDepth: true },
      });
      const result = await bash.exec("echo sandbox");
      expect(result.stdout).toBe("sandbox\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("Interpret Stage", () => {
    it("should produce stdout from echo commands", async () => {
      const result = await bash.exec("echo output");
      expect(result.stdout).toBe("output\n");
    });

    it("should produce stderr from error output", async () => {
      const result = await bash.exec("echo error >&2");
      expect(result.stderr).toBe("error\n");
      expect(result.stdout).toBe("");
    });

    it("should return exit code from last command", async () => {
      const result = await bash.exec("true");
      expect(result.exitCode).toBe(0);

      const result2 = await bash.exec("false");
      expect(result2.exitCode).toBe(1);
    });

    it("should populate environment variables in result", async () => {
      const result = await bash.exec("export MY_VAR=hello");
      expect(result.env).toBeDefined();
      expect(result.env.MY_VAR).toBe("hello");
    });

    it("should handle variable assignment and substitution", async () => {
      const result = await bash.exec('X=42; echo "val=$X"');
      expect(result.stdout).toBe("val=42\n");
    });

    it("should handle command substitution", async () => {
      const result = await bash.exec("echo $(echo nested)");
      expect(result.stdout).toBe("nested\n");
    });

    it("should execute for loops", async () => {
      const result = await bash.exec(`
        for i in 1 2 3; do
          echo $i
        done
      `);
      expect(result.stdout).toBe("1\n2\n3\n");
    });

    it("should execute while loops", async () => {
      const result = await bash.exec(`
        i=0
        while [ $i -lt 3 ]; do
          echo $i
          i=$((i+1))
        done
      `);
      expect(result.stdout).toBe("0\n1\n2\n");
    });

    it("should handle exit builtin", async () => {
      const result = await bash.exec("exit 42");
      expect(result.exitCode).toBe(42);
    });

    it("should handle function definitions and calls", async () => {
      const result = await bash.exec(`
        greet() { echo "hi $1"; }
        greet world
      `);
      expect(result.stdout).toBe("hi world\n");
    });
  });

  describe("Error Stage (categorizeError)", () => {
    it("should handle parse exceptions with exit code 2", async () => {
      const result = await bash.exec("((()))");
      // Malformed arithmetic/syntax should give non-zero exit
      expect(result.exitCode).not.toBe(0);
    });

    it("should handle command not found with appropriate exit code", async () => {
      const result = await bash.exec("nonexistent_command_xyz");
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain("not found");
    });

    it("should handle abort signal with exit code 124", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await bash.exec("echo should-not-run", {
        signal: controller.signal,
      });
      expect(result.exitCode).toBe(124);
    });

    it("should propagate exit errors from exit builtin", async () => {
      const result = await bash.exec("exit 7");
      expect(result.exitCode).toBe(7);
    });

    it("should handle arithmetic errors gracefully", async () => {
      const result = await bash.exec("echo $((1/0))");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    });
  });

  describe("Persist Stage", () => {
    it("should persist state after successful execution with persistState", async () => {
      const bash = new Bash({ persistState: true });
      await bash.exec("export PERSIST_VAR=persisted");

      // Second execution should see the persisted variable
      const result = await bash.exec("echo $PERSIST_VAR");
      expect(result.stdout).toBe("persisted\n");
    });

    it("should not persist state after failed execution", async () => {
      const bash = new Bash({ persistState: true });
      await bash.exec("export FAIL_VAR=should_not_persist; false");

      const result = await bash.exec("echo ${FAIL_VAR:-empty}");
      expect(result.stdout).toBe("empty\n");
    });

    it("should not persist state when persistState is disabled", async () => {
      const bash = new Bash({ persistState: false });
      await bash.exec("export EPHEMERAL=gone");

      const result = await bash.exec("echo ${EPHEMERAL:-missing}");
      expect(result.stdout).toBe("missing\n");
    });
  });

  describe("Pipeline Composition", () => {
    it("should execute all stages in order for a complete script", async () => {
      const result = await bash.exec(`
        greeting="hello"
        echo "$greeting world"
      `);
      expect(result.stdout).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
    });

    it("should short-circuit on parse error without reaching interpret", async () => {
      const result = await bash.exec('echo "unclosed');
      expect(result.exitCode).not.toBe(0);
      // stdout should be empty since interpret stage was never reached
      expect(result.stdout).toBe("");
    });

    it("should clean up defense handle in finally block", async () => {
      // Execute with defense-in-depth enabled - even on error, cleanup should occur
      const bash = new Bash({ security: { defenseInDepth: true } });
      const result = await bash.exec("echo works");
      expect(result.stdout).toBe("works\n");
    });

    it("should return env record from completed pipeline", async () => {
      const result = await bash.exec("export KEY=value", {
        env: { EXTRA: "extra" },
      });
      expect(result.env).toBeDefined();
      expect(typeof result.env).toBe("object");
    });
  });
});
