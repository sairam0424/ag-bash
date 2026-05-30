import { describe, expect, it } from "vitest";
import { AgBashServer } from "./index.js";
import {
  RunBashOutput,
  SearchToolsOutput,
  toOutputSchema,
} from "./output-schema.js";
import {
  LATEST_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  negotiateProtocol,
} from "./protocol.js";

/**
 * End-to-end tests against the REAL AgBashServer (not a mirror class).
 *
 * AgBashServer.run() is gated behind `!process.env.VITEST`, so importing the
 * module under vitest does not start the stdin loop — we drive handleRequest
 * directly and capture the JSON-RPC lines written to stdout.
 */

/**
 * A parsed JSON-RPC response. `result`/`error` are intentionally loose
 * (`any`) so individual tests can assert deeply nested protocol fields without
 * threading a full type for every method's payload — this is test-only code.
 */
interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: any;
  error?: unknown;
}

interface CapturedStdout {
  lines: string[];
  restore: () => void;
}

function captureStdout(): CapturedStdout {
  const lines: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function parse(line: string): JsonRpcResponse {
  return JSON.parse(line.trim()) as JsonRpcResponse;
}

/**
 * Drive a sequence of requests against a fresh server and return the parsed
 * responses (one per non-empty stdout line). The first request is typically an
 * `initialize` to fix the negotiated protocol version.
 */
async function drive(requests: unknown[]): Promise<JsonRpcResponse[]> {
  const server = new AgBashServer();
  const capture = captureStdout();
  try {
    for (const req of requests) {
      await server.handleRequest(req);
    }
  } finally {
    capture.restore();
  }
  return capture.lines.filter((l) => l.trim().length > 0).map(parse);
}

describe("negotiateProtocol (unit)", () => {
  it("honors an exact 2025-06-18 request and enables structured content", () => {
    const n = negotiateProtocol("2025-06-18");
    expect(n.version).toBe("2025-06-18");
    expect(n.supportsStructured).toBe(true);
  });

  it("honors an exact 2024-11-05 request and disables structured content", () => {
    const n = negotiateProtocol("2024-11-05");
    expect(n.version).toBe(LEGACY_PROTOCOL_VERSION);
    expect(n.supportsStructured).toBe(false);
  });

  it("falls back to legacy for an unknown/older dialect", () => {
    const n = negotiateProtocol("2023-01-01");
    expect(n.version).toBe(LEGACY_PROTOCOL_VERSION);
    expect(n.supportsStructured).toBe(false);
  });

  it("offers the latest revision for a newer-than-known future dialect", () => {
    const n = negotiateProtocol("2099-12-31");
    expect(n.version).toBe(LATEST_PROTOCOL_VERSION);
    expect(n.supportsStructured).toBe(true);
  });

  it("defaults to legacy when the client omits a protocol version", () => {
    expect(negotiateProtocol(undefined).version).toBe(LEGACY_PROTOCOL_VERSION);
    expect(negotiateProtocol("").version).toBe(LEGACY_PROTOCOL_VERSION);
    expect(negotiateProtocol(42).version).toBe(LEGACY_PROTOCOL_VERSION);
  });
});

describe("initialize handshake (real server)", () => {
  it("negotiates 2025-06-18 when the client speaks it", async () => {
    const [res] = await drive([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
    ]);
    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect(res.result.serverInfo.name).toBe("ag-bash");
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it("still works for a 2024-11-05 client (back-compat, no hard break)", async () => {
    const [res] = await drive([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      },
    ]);
    expect(res.result.protocolVersion).toBe("2024-11-05");
  });
});

describe("tools/list outputSchema + annotations", () => {
  it("includes outputSchema on native tools for a 2025-06-18 client", async () => {
    const responses = await drive([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    const list = responses[1];
    const tools = list.result.tools;
    const runBash = tools.find((t: { name: string }) => t.name === "run_bash");
    expect(runBash.outputSchema).toBeDefined();
    expect(runBash.outputSchema.type).toBe("object");
    expect(runBash.outputSchema.properties.exitCode.type).toBe("number");
    expect(runBash.outputSchema.properties.stdout.type).toBe("string");
    expect(runBash.outputSchema.required).toContain("exitCode");
  });

  it("OMITS outputSchema for a 2024-11-05 client (back-compat)", async () => {
    const responses = await drive([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    const list = responses[1];
    const tools = list.result.tools;
    const runBash = tools.find((t: { name: string }) => t.name === "run_bash");
    expect(runBash.outputSchema).toBeUndefined();
  });

  it("carries full annotation hints on native tools", async () => {
    const responses = await drive([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    const tools = responses[1].result.tools;

    const runBash = tools.find((t: { name: string }) => t.name === "run_bash");
    expect(runBash.annotations.readOnlyHint).toBe(false);
    expect(runBash.annotations.destructiveHint).toBe(true);
    expect(runBash.annotations.openWorldHint).toBe(true);
    expect(typeof runBash.annotations.idempotentHint).toBe("boolean");

    const getState = tools.find(
      (t: { name: string }) => t.name === "get_state",
    );
    expect(getState.annotations.readOnlyHint).toBe(true);
    expect(getState.annotations.idempotentHint).toBe(true);

    const searchTools = tools.find(
      (t: { name: string }) => t.name === "search_tools",
    );
    expect(searchTools.annotations.readOnlyHint).toBe(true);
  });

  it("lists the search_tools native tool with a required query", async () => {
    const responses = await drive([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    const tools = responses[1].result.tools;
    const searchTools = tools.find(
      (t: { name: string }) => t.name === "search_tools",
    );
    expect(searchTools).toBeDefined();
    expect(searchTools.inputSchema.required).toContain("query");
  });
});

describe("tools/call structuredContent (run_bash)", () => {
  it("returns structuredContent AND a text block for a 2025-06-18 client", async () => {
    const responses = await drive([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "run_bash", arguments: { script: 'echo "hi"' } },
      },
    ]);
    const call = responses[1].result;
    // Text block is always present (back-compat channel).
    expect(call.content[0].type).toBe("text");
    expect(call.content[0].text).toContain("hi");
    // Structured channel present for modern clients.
    expect(call.structuredContent).toBeDefined();
    expect(call.structuredContent.exitCode).toBe(0);
    expect(call.structuredContent.stdout).toContain("hi");
  });

  it("OMITS structuredContent for a 2024-11-05 client (text only)", async () => {
    const responses = await drive([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "run_bash", arguments: { script: 'echo "legacy"' } },
      },
    ]);
    const call = responses[1].result;
    expect(call.content[0].type).toBe("text");
    expect(call.content[0].text).toContain("legacy");
    expect(call.structuredContent).toBeUndefined();
  });
});

describe("tools/call search_tools (Code Mode)", () => {
  it("returns matching tools as structuredContent for a discovery query", async () => {
    const responses = await drive([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "search_tools",
          arguments: { query: "read_file", limit: 5 },
        },
      },
    ]);
    const call = responses[1].result;
    expect(call.structuredContent).toBeDefined();
    expect(call.structuredContent.query).toBe("read_file");
    expect(Array.isArray(call.structuredContent.matches)).toBe(true);
    expect(call.structuredContent.matches.length).toBeGreaterThan(0);
    const names = call.structuredContent.matches.map(
      (m: { name: string }) => m.name,
    );
    // An exact-name query surfaces read_file as the top (deterministic) match.
    expect(names).toContain("read_file");
  });

  it("rejects an empty query with an error result", async () => {
    const responses = await drive([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search_tools", arguments: { query: "" } },
      },
    ]);
    const call = responses[1].result;
    expect(call.isError).toBe(true);
    expect(call.content[0].text).toContain("non-empty string");
  });
});

describe("tools/call resource_link (bridge file tools)", () => {
  it("emits a resource_link for a successful write_file on a 2025-06-18 client", async () => {
    const responses = await drive([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "write_file",
          arguments: {
            path: "/tmp/a5-link.txt",
            content: "linked content",
          },
        },
      },
    ]);
    const call = responses[1].result;
    const link = call.content.find(
      (c: { type: string }) => c.type === "resource_link",
    );
    expect(link).toBeDefined();
    expect(link.uri).toBe("ag-bash://vfs/tmp/a5-link.txt");
    expect(link.name).toBe("/tmp/a5-link.txt");
  });

  it("emits NO resource_link for a 2024-11-05 client (back-compat)", async () => {
    const responses = await drive([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "write_file",
          arguments: {
            path: "/tmp/a5-legacy.txt",
            content: "legacy content",
          },
        },
      },
    ]);
    const call = responses[1].result;
    const link = call.content.find(
      (c: { type: string }) => c.type === "resource_link",
    );
    expect(link).toBeUndefined();
  });
});

describe("toOutputSchema (Zod -> JSON Schema)", () => {
  it("converts a flat object schema with required + types", () => {
    const schema = toOutputSchema(RunBashOutput);
    expect(schema.type).toBe("object");
    expect(schema.properties.stdout).toEqual({
      type: "string",
      description: "Standard output captured from the script.",
    });
    expect(schema.properties.exitCode).toMatchObject({ type: "number" });
    expect(schema.required).toEqual(["stdout", "stderr", "exitCode"]);
  });

  it("converts nested arrays of objects (search_tools matches)", () => {
    const schema = toOutputSchema(SearchToolsOutput);
    expect(schema.properties.matches).toMatchObject({ type: "array" });
    const matches = schema.properties.matches as {
      items: { type: string; properties: Record<string, unknown> };
    };
    expect(matches.items.type).toBe("object");
    expect(matches.items.properties.name).toMatchObject({ type: "string" });
  });
});
