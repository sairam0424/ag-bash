import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bash } from "../Bash.js";
import { levenshtein } from "../lsp/semantic-engine.js";
import type { ExecResult } from "../types.js";
import { AgenticHealer } from "./agentic-healer.js";
import type { AgenticHealerConfig } from "./types.js";

// ─── Unit Tests ──────────────────────────────────────────────────────────────

describe("AgenticHealer - Active Self-Healing", () => {
  const makeResult = (
    exitCode: number,
    stderr: string,
    stdout = "",
  ): ExecResult => ({
    exitCode,
    stderr,
    stdout,
  });

  describe("heal()", () => {
    it("returns null when autoRetry is disabled", async () => {
      const config: AgenticHealerConfig = {
        enableHeuristics: true,
        autoRetry: { enabled: false },
      };
      const healer = new AgenticHealer(undefined, config);

      const result = makeResult(127, "bash: gre: command not found");
      const execFn = vi.fn();

      const healed = await healer.heal("gre file.txt", result, execFn);
      expect(healed).toBeNull();
      expect(execFn).not.toHaveBeenCalled();
    });

    it("returns null when autoRetry config is missing", async () => {
      const config: AgenticHealerConfig = { enableHeuristics: true };
      const healer = new AgenticHealer(undefined, config);

      const result = makeResult(127, "bash: gre: command not found");
      const execFn = vi.fn();

      const healed = await healer.heal("gre file.txt", result, execFn);
      expect(healed).toBeNull();
      expect(execFn).not.toHaveBeenCalled();
    });

    it("returns null when maxRetries is exceeded", async () => {
      const config: AgenticHealerConfig = {
        enableHeuristics: true,
        autoRetry: { enabled: true, maxRetries: 3 },
      };
      const healer = new AgenticHealer(undefined, config);

      const result = makeResult(127, "bash: gre: command not found");
      const execFn = vi.fn();

      // Start at attempt 3 (>= maxRetries of 3)
      const healed = await healer.heal("gre file.txt", result, execFn, 3);
      expect(healed).toBeNull();
      expect(execFn).not.toHaveBeenCalled();
    });

    it("corrects a typo and returns the successful result", async () => {
      const config: AgenticHealerConfig = {
        enableHeuristics: true,
        autoRetry: {
          enabled: true,
          maxRetries: 3,
          baseDelayMs: 1, // Minimal delay for tests
          retryable: ["command_not_found"],
        },
      };
      const healer = new AgenticHealer(undefined, config);

      const failedResult = makeResult(127, "bash: gre: command not found");
      const successResult = makeResult(0, "", "match found");

      const execFn = vi.fn().mockResolvedValue(successResult);

      const healed = await healer.heal("gre file.txt", failedResult, execFn);
      expect(healed).not.toBeNull();
      expect(healed?.exitCode).toBe(0);
      expect(healed?.stdout).toBe("match found");
      expect(execFn).toHaveBeenCalledWith("grep file.txt");
    });

    it("corrects 'ech' to 'echo'", async () => {
      const config: AgenticHealerConfig = {
        enableHeuristics: true,
        autoRetry: {
          enabled: true,
          maxRetries: 3,
          baseDelayMs: 1,
          retryable: ["command_not_found"],
        },
      };
      const healer = new AgenticHealer(undefined, config);

      const failedResult = makeResult(127, "bash: ech: command not found");
      const successResult = makeResult(0, "", "hello world");

      const execFn = vi.fn().mockResolvedValue(successResult);

      const healed = await healer.heal("ech hello world", failedResult, execFn);
      expect(healed).not.toBeNull();
      expect(healed?.stdout).toBe("hello world");
      expect(execFn).toHaveBeenCalledWith("echo hello world");
    });

    it("respects retryable failure types - skips non-retryable", async () => {
      const config: AgenticHealerConfig = {
        enableHeuristics: true,
        autoRetry: {
          enabled: true,
          maxRetries: 3,
          baseDelayMs: 1,
          retryable: ["command_not_found"], // Only command_not_found
        },
      };
      const healer = new AgenticHealer(undefined, config);

      // Permission denied - not in retryable list
      const result = makeResult(1, "bash: ./script.sh: permission denied");
      const execFn = vi.fn();

      const healed = await healer.heal("./script.sh", result, execFn);
      expect(healed).toBeNull();
      expect(execFn).not.toHaveBeenCalled();
    });

    it("does not retry when failure cannot be classified", async () => {
      const config: AgenticHealerConfig = {
        enableHeuristics: true,
        autoRetry: {
          enabled: true,
          maxRetries: 3,
          baseDelayMs: 1,
        },
      };
      const healer = new AgenticHealer(undefined, config);

      // Unclassifiable error
      const result = makeResult(1, "something went wrong unexpectedly");
      const execFn = vi.fn();

      const healed = await healer.heal("mycommand", result, execFn);
      expect(healed).toBeNull();
      expect(execFn).not.toHaveBeenCalled();
    });

    it("retries recursively up to maxRetries on continued failure", async () => {
      const config: AgenticHealerConfig = {
        enableHeuristics: true,
        autoRetry: {
          enabled: true,
          maxRetries: 2,
          baseDelayMs: 1,
          retryable: ["command_not_found"],
        },
      };
      const healer = new AgenticHealer(undefined, config);

      const failedResult = makeResult(127, "bash: gre: command not found");
      // Even the corrected command fails with the same error
      const stillFailed = makeResult(127, "bash: grep: command not found");

      const execFn = vi.fn().mockResolvedValue(stillFailed);

      const healed = await healer.heal("gre file.txt", failedResult, execFn);
      // Should return null eventually (corrections exhaust or cannot improve further)
      expect(healed).toBeNull();
      // At least one attempt was made
      expect(execFn).toHaveBeenCalled();
    });

    it("applies exponential backoff between retries", async () => {
      vi.useFakeTimers();

      const config: AgenticHealerConfig = {
        enableHeuristics: true,
        autoRetry: {
          enabled: true,
          maxRetries: 3,
          baseDelayMs: 100,
          retryable: ["command_not_found"],
        },
      };
      const healer = new AgenticHealer(undefined, config);

      const failedResult = makeResult(127, "bash: gre: command not found");
      const successResult = makeResult(0, "", "ok");
      const execFn = vi.fn().mockResolvedValue(successResult);

      // Start heal and advance timers
      const healPromise = healer.heal("gre file.txt", failedResult, execFn, 0);

      // Advance past the first delay (100 * 2^0 = 100ms)
      await vi.advanceTimersByTimeAsync(100);

      const result = await healPromise;
      expect(result).not.toBeNull();
      expect(result?.exitCode).toBe(0);

      vi.useRealTimers();
    });

    it("returns null when no correction can be suggested", async () => {
      const config: AgenticHealerConfig = {
        enableHeuristics: true,
        autoRetry: {
          enabled: true,
          maxRetries: 3,
          baseDelayMs: 1,
          retryable: ["command_not_found"],
        },
      };
      const healer = new AgenticHealer(undefined, config);

      // "xyzabc" is too far from any known command
      const result = makeResult(127, "bash: xyzabc: command not found");
      const execFn = vi.fn();

      const healed = await healer.heal("xyzabc --flag", result, execFn);
      expect(healed).toBeNull();
      expect(execFn).not.toHaveBeenCalled();
    });
  });

  describe("classifyFailure()", () => {
    let healer: AgenticHealer;

    beforeEach(() => {
      healer = new AgenticHealer(undefined, {
        enableHeuristics: true,
        autoRetry: { enabled: true },
      });
    });

    it("classifies 'command not found'", () => {
      const result = makeResult(127, "bash: foo: command not found");
      expect(healer.classifyFailure(result)).toBe("command_not_found");
    });

    it("classifies 'not found' (generic)", () => {
      const result = makeResult(127, "foo: not found");
      expect(healer.classifyFailure(result)).toBe("command_not_found");
    });

    it("classifies 'no such file'", () => {
      const result = makeResult(
        1,
        "cat: /tmp/missing.txt: No such file or directory",
      );
      expect(healer.classifyFailure(result)).toBe("file_not_found");
    });

    it("classifies 'cannot open'", () => {
      const result = makeResult(1, "cannot open file: data.csv");
      expect(healer.classifyFailure(result)).toBe("file_not_found");
    });

    it("classifies 'permission denied'", () => {
      const result = makeResult(126, "bash: ./locked.sh: Permission denied");
      expect(healer.classifyFailure(result)).toBe("permission_denied");
    });

    it("classifies 'timeout'", () => {
      const result = makeResult(124, "command timed out after 30s");
      expect(healer.classifyFailure(result)).toBe("timeout");
    });

    it("classifies 'timed out'", () => {
      const result = makeResult(124, "connection timed out");
      expect(healer.classifyFailure(result)).toBe("timeout");
    });

    it("returns null for unrecognized errors", () => {
      const result = makeResult(1, "error: something unexpected happened");
      expect(healer.classifyFailure(result)).toBeNull();
    });

    it("returns null for empty stderr", () => {
      const result = makeResult(1, "");
      expect(healer.classifyFailure(result)).toBeNull();
    });
  });

  describe("suggestCorrection()", () => {
    let healer: AgenticHealer;

    beforeEach(() => {
      healer = new AgenticHealer(undefined, {
        enableHeuristics: true,
        autoRetry: { enabled: true },
      });
    });

    it("corrects 'gre' to 'grep'", () => {
      const result = makeResult(127, "bash: gre: command not found");
      expect(healer.suggestCorrection("gre file.txt", result)).toBe(
        "grep file.txt",
      );
    });

    it("corrects 'ech' to 'echo'", () => {
      const result = makeResult(127, "bash: ech: command not found");
      expect(healer.suggestCorrection("ech hello", result)).toBe("echo hello");
    });

    it("corrects 'cta' to 'cat'", () => {
      const result = makeResult(127, "bash: cta: command not found");
      expect(healer.suggestCorrection("cta file.txt", result)).toBe(
        "cat file.txt",
      );
    });

    it("corrects 'mkdri' to 'mkdir'", () => {
      const result = makeResult(127, "bash: mkdri: command not found");
      expect(healer.suggestCorrection("mkdri newdir", result)).toBe(
        "mkdir newdir",
      );
    });

    it("returns null for commands with no close match", () => {
      const result = makeResult(127, "bash: xyzabc: command not found");
      expect(healer.suggestCorrection("xyzabc --flag", result)).toBeNull();
    });

    it("returns null for non command-not-found errors", () => {
      const result = makeResult(1, "error: segfault");
      expect(healer.suggestCorrection("myapp --run", result)).toBeNull();
    });

    it("fixes double slashes in paths for file_not_found", () => {
      const result = makeResult(
        1,
        "cat: /tmp//missing.txt: No such file or directory",
      );
      expect(healer.suggestCorrection("cat /tmp//missing.txt", result)).toBe(
        "cat /tmp/missing.txt",
      );
    });

    it("returns null for file_not_found without double slashes", () => {
      const result = makeResult(
        1,
        "cat: /tmp/missing.txt: No such file or directory",
      );
      expect(
        healer.suggestCorrection("cat /tmp/missing.txt", result),
      ).toBeNull();
    });
  });

  describe("levenshtein() - imported utility", () => {
    it("returns 0 for identical strings", () => {
      expect(levenshtein("grep", "grep")).toBe(0);
    });

    it("returns the length of one string when the other is empty", () => {
      expect(levenshtein("", "abc")).toBe(3);
      expect(levenshtein("abc", "")).toBe(3);
    });

    it("computes single character substitution distance", () => {
      expect(levenshtein("grep", "greo")).toBe(1);
    });

    it("computes single character deletion distance", () => {
      expect(levenshtein("grep", "gre")).toBe(1);
    });

    it("computes single character insertion distance", () => {
      expect(levenshtein("gre", "grep")).toBe(1);
    });

    it("computes multi-character distance", () => {
      expect(levenshtein("cat", "cut")).toBe(1);
      expect(levenshtein("kitten", "sitting")).toBe(3);
    });

    it("is symmetric", () => {
      expect(levenshtein("abc", "xyz")).toBe(levenshtein("xyz", "abc"));
    });
  });
});

// ─── Integration Tests ───────────────────────────────────────────────────────

describe("AgenticHealer - Integration with Interpreter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("provides healer suggestion for typo'd commands", async () => {
    const bash = new Bash({
      agentic: {
        enabled: true,
        healer: {
          enableHeuristics: true,
          autoRetry: {
            enabled: true,
            maxRetries: 3,
            baseDelayMs: 1,
            retryable: ["command_not_found"],
          },
        },
      },
    });

    // "ech" is a typo for "echo" - healer should at minimum suggest correction
    const result = await bash.exec("ech hello");

    // Either auto-corrected (exitCode 0) or got a suggestion
    if (result.exitCode !== 0) {
      expect(result.stderr).toContain("[Agentic Healer]");
    } else {
      expect(result.stdout).toContain("hello");
    }
  });

  it("provides healer suggestion for 'cta' typo", async () => {
    const bash = new Bash({
      files: { "/tmp/test.txt": "file contents here" },
      agentic: {
        enabled: true,
        healer: {
          enableHeuristics: true,
          autoRetry: {
            enabled: true,
            maxRetries: 3,
            baseDelayMs: 1,
            retryable: ["command_not_found"],
          },
        },
      },
    });

    const result = await bash.exec("cta /tmp/test.txt");

    // Either auto-corrected or got a suggestion
    if (result.exitCode !== 0) {
      expect(result.stderr).toContain("[Agentic Healer]");
    } else {
      expect(result.stdout).toContain("file contents here");
    }
  });

  it("falls back to suggestion when autoRetry is disabled", async () => {
    const bash = new Bash({
      agentic: {
        enabled: true,
        healer: {
          enableHeuristics: true,
          autoRetry: { enabled: false },
        },
      },
    });

    const result = await bash.exec("gre pattern file.txt");
    // Should fail but contain a suggestion
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("[Agentic Healer]");
  });

  it("does not auto-heal when agentic mode is off", async () => {
    const bash = new Bash({
      agentic: { enabled: false },
    });

    const result = await bash.exec("gre pattern file.txt");
    expect(result.exitCode).not.toBe(0);
    // No healer message since agentic is off
    expect(result.stderr).not.toContain("[Agentic Healer]");
  });
});
