import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// The shell is bundled to dist/bin/shell/shell.js — one directory deeper than
// dist/bin/ag-bash.js. That extra nesting level is exactly why vendor/WASM
// path resolution must differ from the flat CLI: a path that resolves to
// dist/parser/vendor from dist/bin would land at dist/bin/parser/vendor from
// dist/bin/shell. These tests guard against a regression where the bundled
// shell cannot locate the Tree-sitter grammar at startup.
const binPath = resolve(__dirname, "../../dist/bin/shell/shell.js");
const distVendorDir = resolve(__dirname, "../../dist/parser/vendor");

/**
 * Run the bundled shell non-interactively by piping a script to stdin.
 *
 * The non-interactive read loop attaches its `line`/`close` listeners BEFORE
 * awaiting the initial discovery scan and buffers lines, so piped input is no
 * longer drained-and-lost during the scan await. These tests cover both the
 * WASM/grammar-load path (Tree-sitter init markers on stderr) and the buffered
 * piped-stdin execution path (stdout must contain command output in order).
 */
async function runShell(
  script: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const child = execFileAsync(process.execPath, [binPath], {
      env: { ...process.env },
    });
    child.child.stdin?.end(script);
    const { stdout, stderr } = await child;
    return { stdout, stderr, exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.code ?? 1,
    };
  }
}

describe("ag-shell bundled binary", () => {
  it("ships the Tree-sitter WASM assets at the resolved dist vendor dir", () => {
    // The bundled shell resolves ../../parser/vendor relative to
    // dist/bin/shell, i.e. dist/parser/vendor. Both assets must live there.
    expect(existsSync(resolve(distVendorDir, "web-tree-sitter.wasm"))).toBe(
      true,
    );
    expect(existsSync(resolve(distVendorDir, "tree-sitter-bash.wasm"))).toBe(
      true,
    );
  });

  it("loads the Tree-sitter grammar without an ENOENT/init failure", async () => {
    const result = await runShell("echo hello-from-shell\n");
    // The path-resolution bug surfaced as an aborted WASM load, not a thrown
    // process error, so assert on the absence of those markers explicitly.
    expect(result.stderr).not.toContain(
      "Failed to initialize TreeSitterParser",
    );
    expect(result.stderr).not.toContain("ENOENT");
    expect(result.stderr).not.toContain(
      "failed to asynchronously prepare wasm",
    );
    expect(result.exitCode).toBe(0);
  });

  it("does not abort on a piped command that exercises the parser", async () => {
    const result = await runShell('echo "a\nb\nc" | wc -l\n');
    expect(result.stderr).not.toContain(
      "Failed to initialize TreeSitterParser",
    );
    expect(result.stderr).not.toContain("ENOENT");
    expect(result.exitCode).toBe(0);
  });

  it("executes piped stdin and emits its output (no dropped lines)", async () => {
    // Regression for the readline race: the non-interactive `line` listener
    // was attached only AFTER `await discovery.scan()`, so readline drained
    // the piped stream during the await and lost every line. Buffering before
    // the scan must preserve the command so its output reaches stdout.
    const result = await runShell("echo hi\n");
    expect(result.stdout).toContain("hi");
    expect(result.exitCode).toBe(0);
  });

  it("preserves order across multiple piped lines", async () => {
    const result = await runShell("echo one\necho two\necho three\n");
    expect(result.stdout).toContain("one");
    expect(result.stdout).toContain("two");
    expect(result.stdout).toContain("three");
    // Order must be preserved: drained buffer then live lines, in sequence.
    const idxOne = result.stdout.indexOf("one");
    const idxTwo = result.stdout.indexOf("two");
    const idxThree = result.stdout.indexOf("three");
    expect(idxOne).toBeLessThan(idxTwo);
    expect(idxTwo).toBeLessThan(idxThree);
    expect(result.exitCode).toBe(0);
  });
});
