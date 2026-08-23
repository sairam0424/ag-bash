/**
 * U45 — AgenticHealer diagnosis accuracy and retry safety.
 *
 * The healer mutates and re-executes an agent's command, so a wrong diagnosis
 * produces a confidently wrong mutation. These tests pin three properties:
 *
 *  1. A missing FILE is not a missing COMMAND. They have different remedies:
 *     a missing command name may be a typo worth correcting, a missing path
 *     cannot be fixed by renaming the command.
 *  2. The typo dictionary covers the real command registry, so healing is not
 *     silently unavailable for two thirds of the shell's commands — and never
 *     suggests a command the shell cannot run.
 *  3. A heal that fails is not repeated, and a "correction" that changes
 *     nothing is not a correction at all.
 *
 * The stderr strings below are the ones this codebase actually emits; each is
 * cited at its source so the cases cannot drift into hypotheticals.
 */
import { describe, expect, it, vi } from "vitest";
import {
  getCommandNames,
  getJavaScriptCommandNames,
  getNetworkCommandNames,
  getPythonCommandNames,
} from "../commands/registry.js";
import { SHELL_BUILTINS } from "../interpreter/helpers/shell-constants.js";
import type { ExecResult } from "../types.js";
import { AgenticHealer } from "./agentic-healer.js";
import type { AgenticHealerConfig } from "./types.js";

const makeResult = (
  exitCode: number,
  stderr: string,
  stdout = "",
): ExecResult => ({ exitCode, stderr, stdout });

/** stderr as emitted for a genuinely missing command. */
const commandNotFound = (name: string): ExecResult =>
  makeResult(127, `ag-bash: ${name}: command not found\n`);

const newHealer = (autoRetry?: AgenticHealerConfig["autoRetry"]) =>
  new AgenticHealer(undefined, { enableHeuristics: true, autoRetry });

/** Everything the engine can actually dispatch: registry + shell builtins. */
const dispatchableNames: ReadonlySet<string> = new Set<string>([
  ...getCommandNames(),
  ...getNetworkCommandNames(),
  ...getPythonCommandNames(),
  ...getJavaScriptCommandNames(),
  ...SHELL_BUILTINS,
]);

describe("U45 classifyFailure: a missing file is not a missing command", () => {
  const healer = newHealer({ enabled: true });

  // Real messages emitted by this engine, all of which contain "not found"
  // without containing "command not found".
  const pathFailures: ReadonlyArray<[string, string]> = [
    // packages/bash/src/commands/ag-convert/ag-convert.ts:155
    ["ag-convert", "Error: File not found: /tmp/data.csv\n"],
    // packages/bash/src/commands/ag-notebook/ag-notebook.ts:51
    ["ag-notebook", "File not found: nb.ipynb (resolved to /work/nb.ipynb)\n"],
    // packages/bash/src/interpreter/helpers/result.ts:199
    ["result helper (file)", "File '/tmp/data.csv' not found.\n"],
    // packages/bash/src/interpreter/helpers/result.ts:215
    ["result helper (directory)", "Directory '/tmp/out' not found.\n"],
  ];

  for (const [source, stderr] of pathFailures) {
    it(`classifies ${source} path failure as file_not_found`, () => {
      expect(healer.classifyFailure(makeResult(1, stderr))).toBe(
        "file_not_found",
      );
    });
  }

  it("still classifies a real command-not-found as command_not_found", () => {
    expect(healer.classifyFailure(commandNotFound("gerp"))).toBe(
      "command_not_found",
    );
  });

  it("still classifies the POSIX sh bare 'not found' as command_not_found", () => {
    expect(
      healer.classifyFailure(makeResult(127, "sh: 1: gerp: not found")),
    ).toBe("command_not_found");
  });

  it("keeps classifying 'no such file or directory' as file_not_found", () => {
    expect(
      healer.classifyFailure(
        makeResult(1, "cat: /tmp/missing.txt: No such file or directory"),
      ),
    ).toBe("file_not_found");
  });
});

describe("U45 heal: a path failure gets the path remedy", () => {
  it("heals a real 'File not found' when file_not_found is retryable", async () => {
    const healer = newHealer({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 1,
      retryable: ["file_not_found"],
    });

    // ag-convert.ts:155 wording, with a double slash the path remedy can fix.
    const failed = makeResult(1, "Error: File not found: /tmp//data.csv\n");
    const execFn = vi.fn().mockResolvedValue(makeResult(0, "", "converted"));

    const healed = await healer.heal(
      "ag-convert /tmp//data.csv",
      failed,
      execFn,
    );

    expect(execFn).toHaveBeenCalledWith("ag-convert /tmp/data.csv");
    expect(healed?.exitCode).toBe(0);
  });

  it("does not run anything for a path failure when only command_not_found is retryable", async () => {
    const healer = newHealer({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 1,
      retryable: ["command_not_found"],
    });

    const failed = makeResult(1, "File '/tmp//data.csv' not found.\n");
    const execFn = vi.fn();

    const healed = await healer.heal("cat /tmp//data.csv", failed, execFn);

    expect(healed).toBeNull();
    expect(execFn).not.toHaveBeenCalled();
  });
});

describe("U45 suggestCorrection: dictionary derived from the real registry", () => {
  const healer = newHealer({ enabled: true });

  // Each of these targets a registered command that the legacy 43-name literal
  // omitted, so pre-fix the healer either did nothing or picked the wrong name.
  const cases: ReadonlyArray<[string, string]> = [
    ["pyton3 build.py", "python3 build.py"],
    ["gti status", "git status"],
    ["sqlit3 app.db", "sqlite3 app.db"],
    ["ag-tood list", "ag-todo list"],
    ["jqq .name data.json", "jq .name data.json"],
  ];

  for (const [typo, expected] of cases) {
    it(`corrects '${typo}' to '${expected}'`, () => {
      const cmdName = typo.split(" ")[0];
      expect(healer.suggestCorrection(typo, commandNotFound(cmdName))).toBe(
        expected,
      );
    });
  }

  it("never suggests a command the engine cannot dispatch", () => {
    // 'wge' used to map to 'wget', which this engine does not implement, so the
    // "correction" was guaranteed to fail again.
    const corrected = healer.suggestCorrection(
      "wge https://example.com",
      commandNotFound("wge"),
    );
    const suggestedName = (corrected ?? "").split(" ")[0];

    expect(corrected).not.toBeNull();
    expect(dispatchableNames.has(suggestedName)).toBe(true);
  });

  it("does not invent a command for an empty command string", () => {
    expect(healer.suggestCorrection("", commandNotFound("?"))).toBeNull();
  });

  it("still returns null for a command with no close match", () => {
    expect(
      healer.suggestCorrection("xyzabc --flag", commandNotFound("xyzabc")),
    ).toBeNull();
  });
});

describe("U45 heal: a failed heal must not repeat itself", () => {
  it("treats an unchanged command as no correction at all", () => {
    const healer = newHealer({ enabled: true });
    // 'grep' IS a registered command, so its name is not the problem and there
    // is nothing to correct.
    expect(
      healer.suggestCorrection("grep pat file.txt", commandNotFound("grep")),
    ).toBeNull();
  });

  it("executes a still-failing correction exactly once", async () => {
    const healer = newHealer({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 1,
      retryable: ["command_not_found"],
    });

    const execFn = vi.fn().mockResolvedValue(commandNotFound("grep")); // the corrected command also fails

    const healed = await healer.heal(
      "gre file.txt",
      commandNotFound("gre"),
      execFn,
    );

    expect(healed).toBeNull();
    expect(execFn).toHaveBeenCalledTimes(1);
    expect(execFn).toHaveBeenCalledWith("grep file.txt");
  });

  it("never executes the same command twice within one heal", async () => {
    const healer = newHealer({
      enabled: true,
      maxRetries: 5,
      baseDelayMs: 1,
      retryable: ["command_not_found", "file_not_found"],
    });

    const execFn = vi
      .fn()
      .mockImplementation(async (cmd: string) =>
        commandNotFound(cmd.split(" ")[0]),
      );

    await healer.heal("gre file.txt", commandNotFound("gre"), execFn);

    const executed = execFn.mock.calls.map((call) => String(call[0]));
    expect(new Set(executed).size).toBe(executed.length);
    // The original mangle is never re-run either.
    expect(executed).not.toContain("gre file.txt");
  });

  it("still heals the same command on a later, separate heal call", async () => {
    // The no-repeat rule is scoped to ONE heal chain. A healer instance is
    // shared across an agent session (interpreter ctx, RunLoop), so scoping it
    // to the instance would silently stop healing a command the agent retypes.
    const healer = newHealer({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 1,
      retryable: ["command_not_found"],
    });

    const execFn = vi.fn().mockResolvedValue(makeResult(0, "", "ok"));

    const first = await healer.heal(
      "gre a.txt",
      commandNotFound("gre"),
      execFn,
    );
    const second = await healer.heal(
      "gre a.txt",
      commandNotFound("gre"),
      execFn,
    );

    expect(first?.exitCode).toBe(0);
    expect(second?.exitCode).toBe(0);
    expect(execFn).toHaveBeenCalledTimes(2);
  });
});
