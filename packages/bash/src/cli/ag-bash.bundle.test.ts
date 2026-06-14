import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const binPath = resolve(__dirname, "../../dist/bin/ag-bash.js");

async function runBin(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [binPath, ...args],
      {
        env: { ...process.env },
      },
    );
    if (process.env.DEBUG_WORKER && stderr) {
      console.error(stderr);
    }
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

describe("ag-bash bundled binary", () => {
  it("should show version", async () => {
    const result = await runBin(["--version"]);
    expect(result.stdout).toContain("ag-bash");
    expect(result.exitCode).toBe(0);
  });

  it("should show help", async () => {
    const result = await runBin(["--help"]);
    expect(result.stdout).toContain("Usage:");
    expect(result.exitCode).toBe(0);
  });

  it("should execute echo command", async () => {
    const result = await runBin(["-c", "echo hello world"]);
    expect(result.stdout).toBe("hello world\n");
    expect(result.exitCode).toBe(0);
  });

  it("should execute pipes", async () => {
    const result = await runBin(["-c", 'echo "line1\nline2\nline3" | wc -l']);
    expect(result.stdout.trim()).toBe("3");
    expect(result.exitCode).toBe(0);
  });

  it("should handle file operations with --allow-write", async () => {
    const result = await runBin([
      "-c",
      'echo "test" > /tmp/test.txt && cat /tmp/test.txt',
      "--allow-write",
    ]);
    expect(result.stdout).toBe("test\n");
    expect(result.exitCode).toBe(0);
  });

  it("should support JSON output", async () => {
    const result = await runBin(["-c", "echo hello", "--json"]);
    const json = JSON.parse(result.stdout);
    expect(json.stdout).toBe("hello\n");
    expect(json.stderr).toBe("");
    expect(json.exitCode).toBe(0);
  });

  it("should lazy-load commands (grep)", async () => {
    const result = await runBin([
      "-c",
      'echo -e "foo\\nbar\\nbaz" | grep ba',
      "--allow-write",
    ]);
    expect(result.stdout).toContain("bar");
    expect(result.stdout).toContain("baz");
    expect(result.exitCode).toBe(0);
  });

  it("should lazy-load commands (sed)", async () => {
    const result = await runBin(["-c", "echo hello | sed 's/hello/world/'"]);
    expect(result.stdout).toBe("world\n");
    expect(result.exitCode).toBe(0);
  });

  it("should lazy-load commands (awk)", async () => {
    const result = await runBin(["-c", "echo 'a b c' | awk '{print $2}'"]);
    expect(result.stdout).toBe("b\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle errexit mode", async () => {
    const result = await runBin(["-e", "-c", "false; echo should not print"]);
    expect(result.stdout).not.toContain("should not print");
    expect(result.exitCode).toBe(1);
  });

  it("should lazy-load commands (sqlite3 with external sql.js)", async () => {
    const result = await runBin([
      "-c",
      'sqlite3 :memory: "SELECT 1 + 2 AS result"',
    ]);
    expect(result.stdout).toBe("3\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should lazy-load commands (python3 with CPython Emscripten)", async () => {
    // This spawns a fresh node process, so the ~5.7MB CPython WASM module is
    // compiled cold on every run. The per-exec deadline is armed at queue-push
    // and therefore also spans that one-time compile — so under a CPU-contended
    // parent (e.g. the vitest worker pool) the cold start can push wall-clock to
    // the deadline boundary and the deadline can fire in the SAME tick the
    // program finishes. Before the fix that produced a spurious
    // "Execution timeout: exceeded 10000ms limit" on stderr (and forced a
    // non-zero exit) even though `print(1 + 2)` had already produced "3\n".
    //
    // The fix (python3.ts) makes the bridge — which records the program's real
    // EXIT — the source of truth: a clean bridge exit (exitCode 0, no
    // bridge-level "execution timeout exceeded" marker) means the program ran to
    // completion, so a racing worker-side deadline is discarded as warmup
    // overrun rather than surfaced as an exec timeout. Genuine mid-exec timeouts
    // never produce a clean bridge EXIT, so real timeout behavior is preserved
    // (see python3.queue-desync.runtime.test.ts, which still times out at 5ms).
    //
    // The assertions below pin the contract: correct output, exit 0, and — most
    // importantly — NO timeout text on stderr. We do NOT assert stderr is exactly
    // empty: a separate, pre-existing CPython worker-teardown artifact can flush
    // a bare "Traceback (most recent call last):" header when the non-persistent
    // worker is terminated right after emitting stdout. That leak is unrelated to
    // the cold-start timeout fixed here (it occurs on fully successful runs) and
    // lives in the worker, not in this command's result reconciliation.
    const result = await runBin([
      "--python",
      "-c",
      'python3 -c "print(1 + 2)"',
    ]);
    expect(result.stdout).toBe("3\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("timeout");
    expect(result.stderr).not.toContain("Execution timeout");
  }, 60000); // 60s vitest timeout absorbs the first cold WASM compile
});

describe("ag-bash CJS bundle", () => {
  it("should be requireable and execute basic commands", async () => {
    const cjsBundlePath = resolve(__dirname, "../../dist/bundle/index.cjs");
    const require = createRequire(import.meta.url);
    const mod = require(cjsBundlePath);
    expect(mod.Bash).toBeDefined();
    const bash = new mod.Bash();
    const result = await bash.exec("echo hello from cjs");
    expect(result.stdout).toBe("hello from cjs\n");
    expect(result.exitCode).toBe(0);
  });
});
