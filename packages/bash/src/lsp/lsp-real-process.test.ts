/**
 * Language-server lifecycle against REAL child processes.
 *
 * lsp-lifecycle.test.ts proves the behaviour with a mocked spawn; this file
 * proves it with the operating system as the judge. A tiny stand-in for
 * `typescript-language-server` (a node script, so no real language server is
 * needed) is put first on PATH, and the checks look at what the OS and the Node
 * event loop actually hold: live processes, ProcessWrap/PipeWrap handles and
 * post-GC heap.
 *
 * The assertions compare counts of handles and processes, never timings. The
 * only waiting is a bounded poll for a process to exit after destroy().
 *
 * POSIX only: the stand-in is an executable /bin/sh wrapper around a node
 * script, so a node binary or temp directory whose path contains spaces works.
 * If a script in the temp directory cannot be executed at all (for example a
 * `noexec` mount), the suite is skipped and its title says why.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import v8 from "node:v8";
import vm from "node:vm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

/**
 * - responsive: answers `initialize` and every later request
 * - mute: starts, but never answers `initialize`
 * - missing: no such binary on PATH (spawn fails with ENOENT)
 */
type ServerMode = "responsive" | "mute" | "missing";

const FAKE_SERVER_SOURCE = [
  'const { appendFileSync } = require("node:fs");',
  "const log = process.env.FAKE_LSP_LOG;",
  'const mute = process.env.FAKE_LSP_MODE === "mute";',
  "const note = (line) => {",
  "  if (!log) return;",
  '  try { appendFileSync(log, line + "\\n"); } catch (error) { void error; }',
  "};",
  'note("start " + process.pid);',
  "let buffer = Buffer.alloc(0);",
  "const send = (message) => {",
  "  const json = JSON.stringify(message);",
  '  process.stdout.write("Content-Length: " + Buffer.byteLength(json) + "\\r\\n\\r\\n" + json);',
  "};",
  'process.stdin.on("data", (chunk) => {',
  "  buffer = Buffer.concat([buffer, chunk]);",
  "  for (;;) {",
  '    const match = /Content-Length: (\\d+)\\r\\n\\r\\n/.exec(buffer.toString("utf-8"));',
  "    if (!match) return;",
  "    const headerLength = match[0].length;",
  "    const bodyLength = Number.parseInt(match[1], 10);",
  "    if (buffer.length < headerLength + bodyLength) return;",
  '    const message = JSON.parse(buffer.toString("utf-8", headerLength, headerLength + bodyLength));',
  "    buffer = buffer.subarray(headerLength + bodyLength);",
  "    if (message.id === undefined || message.method === undefined) continue;",
  '    if (message.method === "initialize") {',
  '      if (!mute) send({ jsonrpc: "2.0", id: message.id, result: { capabilities: null } });',
  "    } else {",
  '      send({ jsonrpc: "2.0", id: message.id, result: { pid: process.pid, method: message.method } });',
  "    }",
  "  }",
  "});",
  'process.stdin.on("end", () => process.exit(0));',
  "",
].join("\n");

/** POSIX shell quoting: safe for any path, including spaces and quotes. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * An executable that runs `script` with this node binary. Its shebang is the
 * fixed path /bin/sh: a shebang line cannot carry an interpreter path that
 * contains spaces, so the node path and the script path are quoted here instead.
 */
function wrapperSource(script: string): string {
  return `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`;
}

/**
 * Whether a wrapper written to the temp directory can be executed. A `noexec`
 * mount (or no /bin/sh) would fail every spawn below for reasons that have
 * nothing to do with the code under test, so the suite is skipped instead. The
 * probe runs the same wrapper-around-node shape the stand-in uses.
 */
function canRunWrapperFromTmpdir(): boolean {
  if (process.platform === "win32") return false;
  let dir = "";
  try {
    dir = mkdtempSync(join(tmpdir(), "ag-bash-lsp-probe-"));
    const script = join(dir, "probe.cjs");
    const wrapper = join(dir, "probe");
    writeFileSync(script, 'process.stdout.write("ok");\n');
    writeFileSync(wrapper, wrapperSource(script));
    chmodSync(wrapper, 0o755);
    const run = spawnSync(wrapper, [], { encoding: "utf-8", timeout: 20_000 });
    return run.status === 0 && run.stdout === "ok";
  } catch {
    return false;
  } finally {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  }
}

const CAN_RUN_STAND_IN = canRunWrapperFromTmpdir();
const SUITE_TITLE = CAN_RUN_STAND_IN
  ? "language server lifecycle (real processes)"
  : `language server lifecycle (real processes) - SKIPPED: a script in ${tmpdir()} cannot be executed here`;

const ORIGINAL_ENV = new Map<string, string | undefined>([
  ["PATH", process.env.PATH],
  ["FAKE_LSP_MODE", process.env.FAKE_LSP_MODE],
  ["FAKE_LSP_LOG", process.env.FAKE_LSP_LOG],
]);

const MB = 1024 * 1024;
const CYCLES = 100;
/**
 * Post-GC heap growth allowed over CYCLES instances. The fault pinned ~400 KB
 * per instance (~40 MB here); a healthy Bash leaves well under 150 KB each.
 */
const HEAP_GROWTH_BOUND_MB = 15;

let workDir = "";
let serverDir = "";
let emptyDir = "";
let logFile = "";

function useServer(mode: ServerMode): void {
  process.env.PATH =
    mode === "missing"
      ? emptyDir
      : [serverDir, ORIGINAL_ENV.get("PATH") ?? ""].join(delimiter);
  process.env.FAKE_LSP_MODE = mode === "mute" ? "mute" : "responsive";
  process.env.FAKE_LSP_LOG = logFile;
  writeFileSync(logFile, "");
}

function restoreEnv(): void {
  for (const [name, value] of ORIGINAL_ENV) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

/** PIDs of every stand-in server that has been started since useServer(). */
function serverStarts(): number[] {
  return readFileSync(logFile, "utf-8")
    .split("\n")
    .filter((line) => line.startsWith("start "))
    .map((line) => Number.parseInt(line.slice("start ".length), 10));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function osHandles(): number {
  return process
    .getActiveResourcesInfo()
    .filter((type) => type === "ProcessWrap" || type === "PipeWrap").length;
}

/** Poll until `done()` holds; the bound only stops a broken run from hanging. */
async function eventually(
  done: () => boolean,
  boundMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    if (done()) return true;
    await sleep(20);
  }
  return done();
}

const collectGarbage = (() => {
  v8.setFlagsFromString("--expose-gc");
  return vm.runInNewContext("gc") as () => void;
})();

const definitionRequest = (filePath: string) => ({
  method: "textDocument/definition",
  params: { symbolName: "foo" },
  filePath,
});

describe.skipIf(!CAN_RUN_STAND_IN)(SUITE_TITLE, () => {
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "ag-bash-lsp-"));
    serverDir = join(workDir, "bin");
    emptyDir = join(workDir, "empty");
    logFile = join(workDir, "server.log");
    mkdirSync(serverDir);
    mkdirSync(emptyDir);
    const serverScript = join(workDir, "fake-server.cjs");
    writeFileSync(serverScript, FAKE_SERVER_SOURCE);
    const binary = join(serverDir, "typescript-language-server");
    writeFileSync(binary, wrapperSource(serverScript));
    chmodSync(binary, 0o755);
  });

  afterEach(restoreEnv);
  afterAll(() => {
    restoreEnv();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("constructing and destroying instances starts no process", async () => {
    useServer("responsive");
    const handlesBefore = osHandles();

    for (let i = 0; i < 20; i++) {
      new Bash().destroy();
    }
    await sleep(300);

    expect(serverStarts()).toEqual([]);
    expect(osHandles()).toBe(handlesBefore);
  });

  it("starts a server on first use and destroy() ends its process and pipes", async () => {
    useServer("responsive");
    const handlesBefore = osHandles();
    const bash = new Bash();

    const result = (await bash.lsp.sendRequest(
      bash,
      definitionRequest("/a.ts"),
    )) as { pid: number; method: string };

    expect(result.method).toBe("textDocument/definition");
    expect(serverStarts()).toEqual([result.pid]);
    expect(isAlive(result.pid)).toBe(true);
    expect(osHandles()).toBeGreaterThan(handlesBefore);

    bash.destroy();
    bash.destroy();

    const released = await eventually(
      () => !isAlive(result.pid) && osHandles() === handlesBefore,
    );
    expect(released).toBe(true);
    expect(serverStarts()).toEqual([result.pid]);
  });

  it("concurrent first requests share a single process", async () => {
    useServer("responsive");
    const bash = new Bash();

    const results = (await Promise.all(
      Array.from({ length: 8 }, () =>
        bash.lsp.sendRequest(bash, definitionRequest("/a.ts")),
      ),
    )) as Array<{ pid: number }>;

    const starts = serverStarts();
    expect(starts).toHaveLength(1);
    expect(new Set(results.map((r) => r.pid))).toEqual(new Set(starts));

    bash.destroy();
    await eventually(() => !isAlive(starts[0]));
  });

  it("a first request made by a host command inside exec() starts the server without security violations", async () => {
    useServer("responsive");
    const violations: string[] = [];
    const bash: Bash = new Bash({
      security: {
        defenseInDepth: {
          enabled: true,
          auditMode: false,
          onViolation: (violation) => violations.push(violation.type),
        },
      },
      customCommands: [
        {
          name: "lsp-probe",
          // Host-defined commands (defineCommand) are trusted by default.
          trusted: true,
          execute: async () => {
            const result = await bash.lsp.sendRequest(
              bash,
              definitionRequest("/a.ts"),
            );
            return {
              stdout: JSON.stringify(result),
              stderr: "",
              exitCode: 0,
            };
          },
        },
      ],
    });

    const run = await bash.exec("lsp-probe");
    expect(violations).toEqual([]);
    expect(run.stderr).toBe("");
    const result = JSON.parse(run.stdout) as { pid: number; method: string };

    expect(run.exitCode).toBe(0);
    expect(result.method).toBe("textDocument/definition");
    expect(serverStarts()).toEqual([result.pid]);

    bash.destroy();
    expect(await eventually(() => !isAlive(result.pid))).toBe(true);
  });

  it("a destroyed instance can use LSP again with a fresh process", async () => {
    useServer("responsive");
    const bash = new Bash();

    const first = (await bash.lsp.sendRequest(
      bash,
      definitionRequest("/a.ts"),
    )) as { pid: number };
    bash.destroy();
    const second = (await bash.lsp.sendRequest(
      bash,
      definitionRequest("/a.ts"),
    )) as { pid: number };

    expect(second.pid).not.toBe(first.pid);
    expect(serverStarts()).toEqual([first.pid, second.pid]);

    bash.destroy();
    const released = await eventually(
      () => !isAlive(first.pid) && !isAlive(second.pid),
    );
    expect(released).toBe(true);
  });

  describe("leak guard", () => {
    // The fuzz suites build tens of thousands of instances in loops that never
    // yield to the event loop's macrotask phases. A language server that is
    // spawned (or fails to spawn) per instance keeps its process and pipe
    // handles - and, through them, the whole Bash - pinned until the loop
    // yields. So the measurements are taken synchronously after the loop,
    // before anything can yield, and only then re-checked after settling.
    it.each([
      "missing",
      "mute",
      "responsive",
    ] as const)(`%s server: ${CYCLES} construct+exec+destroy cycles hold no handles and little heap`, async (mode) => {
      useServer(mode);
      for (let i = 0; i < 3; i++) {
        const warm = new Bash(); // warm up one-time module state
        await warm.exec("true");
        warm.destroy();
      }
      await sleep(300);
      collectGarbage();
      collectGarbage();
      const heapBefore = process.memoryUsage().heapUsed;
      const handlesBefore = osHandles();

      for (let i = 0; i < CYCLES; i++) {
        const bash = new Bash();
        await bash.exec("echo hi");
        bash.destroy();
      }
      // Nothing has been awaited on a timer or I/O since the loop began.
      collectGarbage();
      collectGarbage();
      const heapAfter = process.memoryUsage().heapUsed;
      const handlesAfter = osHandles();

      expect(handlesAfter).toBe(handlesBefore);
      expect((heapAfter - heapBefore) / MB).toBeLessThan(HEAP_GROWTH_BOUND_MB);

      await sleep(300);
      expect(serverStarts()).toEqual([]);
      expect(osHandles()).toBe(handlesBefore);
    }, 60_000);
  });
});
