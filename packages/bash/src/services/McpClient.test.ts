import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
