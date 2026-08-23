/**
 * U19 — the builtin count must be derived from the command registry, never
 * hardcoded.
 *
 * The banner counts BARE BUILTINS (`getCommandNames()`), deliberately excluding
 * the runtime-gated extras (curl / python3 / python / js-exec / node):
 *
 *   1. The COMMANDS row describes itself as "Statically analyzable built-ins".
 *      The runtime-gated commands are precisely the ones that are NOT statically
 *      analyzable — they escape into WASM or the network.
 *   2. PYTHON and JAVASCRIPT already have their own manifest rows reporting
 *      Enabled/Available, so folding them into COMMANDS double-reports them.
 *   3. It is invocation-independent, so `ag-bash` (which knows the --python /
 *      --javascript flags) and `ag-shell` (which does not) cannot disagree —
 *      and disagreement between the call sites is the actual bug being fixed.
 *
 * Every assertion here compares against the accessor, never against a literal,
 * so adding a builtin can never make this test stale.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getCommandNames } from "../commands/registry.js";
import { Theme } from "./theme.js";

/** The single source of truth. Never inline this number. */
const registryBuiltinCount = (): number => getCommandNames().length;

const COMMANDS_ROW = /COMMANDS\s+(\d+)\s/;
/** Any hardcoded numeric commands count, e.g. `commands: 120` / `commands = 100`. */
const HARDCODED_COMMANDS_COUNT = /\bcommands\s*[:=]\s*\d/;

function captureStdout(run: () => void): string {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]): void => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

function commandsCellOf(output: string): number {
  const match = COMMANDS_ROW.exec(output);
  if (!match?.[1]) {
    throw new Error(
      `No COMMANDS row found in manifest output:\n${output.slice(0, 400)}`,
    );
  }
  return Number.parseInt(match[1], 10);
}

describe("builtin count is registry-derived", () => {
  it("exposes a non-trivial registry count to compare against", () => {
    expect(registryBuiltinCount()).toBeGreaterThan(50);
  });

  it("printManifest() defaults COMMANDS to the registry count", () => {
    const output = captureStdout(() => {
      Theme.printManifest();
    });
    expect(commandsCellOf(output)).toBe(registryBuiltinCount());
  });

  it("printSuccess() forwards the registry-derived count (ag-shell banner)", () => {
    const output = captureStdout(() => {
      Theme.printSuccess("Node.js", "Interactive Shell", {
        filesystems: 2,
        python: "Enabled",
        javascript: "Enabled",
      });
    });
    expect(commandsCellOf(output)).toBe(registryBuiltinCount());
  });

  it("still honours an explicit commands override", () => {
    const output = captureStdout(() => {
      Theme.printManifest({ commands: 7 });
    });
    expect(commandsCellOf(output)).toBe(7);
  });

  it.each([
    "ag-bash.ts",
    "shell.ts",
    "theme.ts",
  ])("cli/%s contains no hardcoded numeric commands count", async (file) => {
    const source = await readFile(join(__dirname, file), "utf-8");
    const offenders = source
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => HARDCODED_COMMANDS_COUNT.test(line))
      .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});
