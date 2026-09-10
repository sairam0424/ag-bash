import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import type { CommandContext } from "../types.js";
import { McpClient } from "./McpClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = resolve(__dirname, "__fixtures__/fake-mcp-server.mjs");

/**
 * connectStdio() only reads `cmdCtx.bash`; the rest of CommandContext (fs,
 * cwd, env, stdin) is irrelevant to spawning an MCP server, so a minimal
 * synthetic context is used rather than fabricating a full shell context.
 */
function fakeCommandContext(bash: Bash): CommandContext {
  return { bash } as unknown as CommandContext;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `transport.close()` sends SIGTERM, which the OS delivers asynchronously —
 * the child process needs an event-loop tick to actually exit. Poll instead
 * of asserting immediately to avoid a race that would make this test flaky.
 */
async function waitForProcessExit(
  pid: number,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return !isProcessAlive(pid);
}

/**
 * The fixture writes its pid file on Node startup, which is not instant
 * (module load, readline setup). Poll for it rather than assuming it exists
 * the moment the handshake timeout fires.
 */
async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${path} to exist`);
}

describe("McpClient stdio protocol compliance", () => {
  it("performs the initialize handshake before discovering tools", async () => {
    const bash = new Bash();
    const client = new McpClient();
    const conn = await client.connectStdio(
      "fake",
      "node",
      [FIXTURE_SERVER],
      fakeCommandContext(bash),
    );
    expect(conn.status).toBe("connected");
    expect(conn.tools.map((t) => t.name)).toEqual(["echo"]);
    client.disconnect("fake");
  });

  it("calls tools via the spec-correct tools/call method", async () => {
    const bash = new Bash();
    const client = new McpClient();
    await client.connectStdio(
      "fake",
      "node",
      [FIXTURE_SERVER],
      fakeCommandContext(bash),
    );
    const result = await client.callTool(
      "fake",
      "echo",
      { text: "hello" },
      bash,
    );
    expect(result).toEqual({ content: [{ type: "text", text: "hello" }] });
    client.disconnect("fake");
  });
});

describe("McpClient handshake failure cleanup", () => {
  let pidDir: string | undefined;

  afterEach(() => {
    delete process.env.FAKE_MCP_HANG_INIT;
    delete process.env.FAKE_MCP_PID_FILE;
    if (pidDir) {
      rmSync(pidDir, { recursive: true, force: true });
      pidDir = undefined;
    }
  });

  it("does not orphan the child process when the initialize handshake times out", async () => {
    pidDir = mkdtempSync(join(tmpdir(), "mcp-client-test-"));
    const pidFile = join(pidDir, "pid");
    process.env.FAKE_MCP_HANG_INIT = "1";
    process.env.FAKE_MCP_PID_FILE = pidFile;

    const bash = new Bash();
    const client = new McpClient();

    await expect(
      client.connectStdio(
        "fake-hang",
        "node",
        [FIXTURE_SERVER],
        fakeCommandContext(bash),
        { requestTimeoutMs: 300 },
      ),
    ).rejects.toThrow(/timed out/);

    // The fixture writes its own pid on startup; if the client didn't close
    // the transport after the handshake rejected, this pid would still be a
    // live process (orphaned until the whole Node process exits).
    await waitForFile(pidFile);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(await waitForProcessExit(pid)).toBe(true);

    // The failed connection must not be reachable afterward either.
    expect(client.listConnections()).toHaveLength(0);
  });
});
