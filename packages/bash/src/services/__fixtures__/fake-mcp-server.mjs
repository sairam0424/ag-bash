#!/usr/bin/env node
/**
 * Minimal spec-correct MCP stdio server, used ONLY by McpClient.test.ts to
 * verify the real client speaks the real MCP handshake + tools/list +
 * tools/call methods, without spawning a live browser or network service.
 *
 * Gates tools/list and tools/call on having seen "initialize" first,
 * mirroring a real MCP server (e.g. browser-harness-mcp) so the test can
 * assert on handshake ordering, not just method-name spelling.
 *
 * Two env vars support the "handshake failure must not orphan the child
 * process" regression test:
 * - `FAKE_MCP_HANG_INIT=1`: never respond to `initialize`, simulating a
 *   server that hangs during the handshake so the client's request times
 *   out (`requestTimeoutMs`) and `handshake()` rejects.
 * - `FAKE_MCP_PID_FILE=<path>`: write this process's pid to the given file
 *   on startup, so a test can poll whether the process is still alive after
 *   the client is expected to have closed the transport.
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.FAKE_MCP_PID_FILE) {
  writeFileSync(process.env.FAKE_MCP_PID_FILE, String(process.pid));
}

const rl = createInterface({ input: process.stdin });
let initialized = false;

const TOOLS = [
  {
    name: "echo",
    description: "Echoes back its input",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  if (method === "initialize") {
    if (process.env.FAKE_MCP_HANG_INIT) {
      // Deliberately never respond, so the client's request times out.
      return;
    }
    initialized = true;
    respond(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      // @banned-pattern-ignore: static keys only, never accessed with user input
      capabilities: {},
      serverInfo: { name: "fake-mcp-server", version: "0.0.0" },
    });
    return;
  }
  if (method === "notifications/initialized") {
    // Notification: no response expected, and none is sent.
    return;
  }
  if (method === "tools/list") {
    if (!initialized) {
      respondError(id, -32002, "Server not initialized");
      return;
    }
    respond(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    if (!initialized) {
      respondError(id, -32002, "Server not initialized");
      return;
    }
    if (params?.name === "echo") {
      respond(id, {
        content: [
          { type: "text", text: String(params?.arguments?.text ?? "") },
        ],
      });
      return;
    }
    respondError(id, -32601, `Unknown tool: ${params?.name}`);
    return;
  }
  respondError(id, -32601, `Method not found: ${method}`);
});
