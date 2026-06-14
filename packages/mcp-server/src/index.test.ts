import { describe, it, expect, vi, beforeEach } from "vitest";

const mockBashInstance = {
  exec: vi.fn(),
  getCwd: vi.fn(),
  getEnv: vi.fn(),
  snapshot: vi.fn(),
  restore: vi.fn(),
  createDelta: vi.fn(),
  applyDelta: vi.fn(),
  fs: {
    getAllPaths: vi.fn(),
    readFile: vi.fn(),
  },
};

vi.mock("@ag-bash/bash", () => ({
  Bash: vi.fn(() => mockBashInstance),
}));

function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Buffer) => {
    output.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  return {
    output,
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}

function sanitizeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Internal server error";
  const msg = error.message;
  const sanitized = msg
    .replace(/\/[\w./-]+/g, "[path]")
    .replace(/[A-Z]:\\[\w\\.-]+/g, "[path]");
  return sanitized.length > 200 ? `${sanitized.slice(0, 200)}...` : sanitized;
}

class TestableServer {
  private bash: typeof mockBashInstance;
  private readonly protocolVersion = "2024-11-05";

  constructor() {
    this.bash = mockBashInstance;
  }

  private sendResponse(id: string | number | null, resultOrError: any) {
    const response = { jsonrpc: "2.0", id, ...resultOrError };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  async handleRequest(request: any) {
    const { method, params, id } = request;
    try {
      switch (method) {
        case "initialize":
          return this.sendResponse(id, {
            result: {
              protocolVersion: this.protocolVersion,
              capabilities: {
                tools: Object.create(null),
                resources: { subscribe: true },
              },
              serverInfo: { name: "ag-bash", version: "3.0.0" },
            },
          });
        case "notifications/initialized":
          return;
        case "tools/list":
          return this.sendResponse(id, {
            result: {
              tools: [
                {
                  name: "run_bash",
                  description:
                    "Run a bash script in a persistent sandboxed environment. State (cwd, variables, functions) persists between calls.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      script: {
                        type: "string",
                        description: "The bash script to execute.",
                      },
                    },
                    required: ["script"],
                  },
                },
                {
                  name: "get_state",
                  description:
                    "Retrieve the current state of the shell (CWD and Environment Variables).",
                  inputSchema: {
                    type: "object",
                    properties: Object.create(null),
                  },
                },
                {
                  name: "snapshot",
                  description:
                    "Capture a complete binary snapshot of the current shell state (filesystem + environment).",
                  inputSchema: {
                    type: "object",
                    properties: Object.create(null),
                  },
                },
                {
                  name: "restore",
                  description:
                    "Restore the shell to a previously captured state via a snapshot.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      snapshot: {
                        type: "string",
                        description:
                          "The base64 encoded snapshot state to restore.",
                      },
                    },
                    required: ["snapshot"],
                  },
                },
                {
                  name: "create_delta",
                  description:
                    "Create a differential delta between a base snapshot and current state for efficient sync.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      baseSnapshot: {
                        type: "string",
                        description: "The base64 encoded base snapshot.",
                      },
                    },
                    required: ["baseSnapshot"],
                  },
                },
                {
                  name: "apply_delta",
                  description:
                    "Apply a differential delta to the current shell state.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      delta: {
                        type: "string",
                        description: "The base64 encoded delta to apply.",
                      },
                    },
                    required: ["delta"],
                  },
                },
              ],
            },
          });
        case "tools/call": {
          const { name, arguments: args } = params;
          if (name === "run_bash") {
            const script = String(args?.script || "");
            const result = await this.bash.exec(script, { persistState: true });
            let output = "";
            if (result.stdout) output += result.stdout;
            if (result.stderr) output += `\nError:\n${result.stderr}`;
            return this.sendResponse(id, {
              result: {
                content: [{ type: "text", text: output || "(No output)" }],
                isError: result.exitCode !== 0,
              },
            });
          } else if (name === "get_state") {
            return this.sendResponse(id, {
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      { cwd: this.bash.getCwd(), env: this.bash.getEnv() },
                      null,
                      2,
                    ),
                  },
                ],
              },
            });
          } else if (name === "snapshot") {
            const state = await this.bash.snapshot();
            const encoded = Buffer.from(JSON.stringify(state)).toString(
              "base64",
            );
            return this.sendResponse(id, {
              result: { content: [{ type: "text", text: encoded }] },
            });
          } else if (name === "restore") {
            const encodedSnapshot = String(args?.snapshot || "");
            const snapshotState = JSON.parse(
              Buffer.from(encodedSnapshot, "base64").toString("utf-8"),
            );
            await this.bash.restore(snapshotState);
            return this.sendResponse(id, {
              result: {
                content: [
                  { type: "text", text: "State restored successfully." },
                ],
              },
            });
          } else if (name === "create_delta") {
            const encodedBase = String(args?.baseSnapshot || "");
            const base = JSON.parse(
              Buffer.from(encodedBase, "base64").toString("utf-8"),
            );
            const delta = await this.bash.createDelta(base);
            const encodedDelta = Buffer.from(JSON.stringify(delta)).toString(
              "base64",
            );
            return this.sendResponse(id, {
              result: { content: [{ type: "text", text: encodedDelta }] },
            });
          } else if (name === "apply_delta") {
            const encodedDelta = String(args?.delta || "");
            const delta = JSON.parse(
              Buffer.from(encodedDelta, "base64").toString("utf-8"),
            );
            await this.bash.applyDelta(delta);
            return this.sendResponse(id, {
              result: {
                content: [
                  { type: "text", text: "Delta applied successfully." },
                ],
              },
            });
          }
          break;
        }
        case "resources/list": {
          const paths = this.bash.fs.getAllPaths();
          return this.sendResponse(id, {
            result: {
              resources: paths.map((p: string) => ({
                uri: `ag-bash://vfs${p}`,
                name: p,
                mimeType: "text/plain",
              })),
            },
          });
        }
        case "resources/read": {
          const uri = String(params?.uri || "");
          const path = uri.replace("ag-bash://vfs", "");
          try {
            const content = await this.bash.fs.readFile(path);
            return this.sendResponse(id, {
              result: { contents: [{ uri, text: content }] },
            });
          } catch (_e) {
            return this.sendResponse(id, {
              error: { code: -32602, message: `Resource not found: ${path}` },
            });
          }
        }
        case "ping":
          return this.sendResponse(id, { result: {} });
      }
      return this.sendResponse(id, {
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    } catch (error) {
      return this.sendResponse(id, {
        error: { code: -32603, message: sanitizeErrorMessage(error) },
      });
    }
  }
}

describe("AgBashServer", () => {
  let server: TestableServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new TestableServer();
  });

  function parseResponse(raw: string): any {
    return JSON.parse(raw.trim());
  }

  describe("initialize", () => {
    it("returns server info and capabilities", async () => {
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: {},
        });
        const response = parseResponse(capture.output[0]);
        expect(response.jsonrpc).toBe("2.0");
        expect(response.id).toBe(1);
        expect(response.result.protocolVersion).toBe("2024-11-05");
        expect(response.result.serverInfo.name).toBe("ag-bash");
        expect(response.result.serverInfo.version).toBe("3.0.0");
        expect(response.result.capabilities.tools).toEqual({});
        expect(response.result.capabilities.resources.subscribe).toBe(true);
      } finally {
        capture.restore();
      }
    });
  });

  describe("notifications/initialized", () => {
    it("does not send a response", async () => {
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        });
        expect(capture.output).toHaveLength(0);
      } finally {
        capture.restore();
      }
    });
  });

  describe("tools/list", () => {
    it("returns all six available tools", async () => {
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 2,
          params: {},
        });
        const response = parseResponse(capture.output[0]);
        expect(response.id).toBe(2);
        const tools = response.result.tools;
        expect(tools).toHaveLength(6);
        const toolNames = tools.map((t: any) => t.name);
        expect(toolNames).toContain("run_bash");
        expect(toolNames).toContain("get_state");
        expect(toolNames).toContain("snapshot");
        expect(toolNames).toContain("restore");
        expect(toolNames).toContain("create_delta");
        expect(toolNames).toContain("apply_delta");
      } finally {
        capture.restore();
      }
    });

    it("includes proper input schemas for run_bash", async () => {
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 3,
          params: {},
        });
        const response = parseResponse(capture.output[0]);
        const runBash = response.result.tools.find(
          (t: any) => t.name === "run_bash",
        );
        expect(runBash.inputSchema.type).toBe("object");
        expect(runBash.inputSchema.required).toContain("script");
        expect(runBash.inputSchema.properties.script.type).toBe("string");
      } finally {
        capture.restore();
      }
    });

    it("includes proper input schema for restore requiring snapshot param", async () => {
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 4,
          params: {},
        });
        const response = parseResponse(capture.output[0]);
        const restoreTool = response.result.tools.find(
          (t: any) => t.name === "restore",
        );
        expect(restoreTool.inputSchema.required).toContain("snapshot");
      } finally {
        capture.restore();
      }
    });
  });

  describe("tools/call - run_bash", () => {
    it("runs a script and returns stdout", async () => {
      mockBashInstance.exec.mockResolvedValue({
        stdout: "hello world\n",
        stderr: "",
        exitCode: 0,
      });
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 10,
          params: {
            name: "run_bash",
            arguments: { script: "echo hello world" },
          },
        });
        const response = parseResponse(capture.output[0]);
        expect(response.id).toBe(10);
        expect(response.result.content[0].text).toBe("hello world\n");
        expect(response.result.isError).toBe(false);
        expect(mockBashInstance.exec).toHaveBeenCalledWith(
          "echo hello world",
          { persistState: true },
        );
      } finally {
        capture.restore();
      }
    });

    it("returns stderr when command fails", async () => {
      mockBashInstance.exec.mockResolvedValue({
        stdout: "",
        stderr: "command not found: foobar",
        exitCode: 127,
      });
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 11,
          params: { name: "run_bash", arguments: { script: "foobar" } },
        });
        const response = parseResponse(capture.output[0]);
        expect(response.result.isError).toBe(true);
        expect(response.result.content[0].text).toContain(
          "command not found: foobar",
        );
      } finally {
        capture.restore();
      }
    });

    it("returns (No output) when command produces no output", async () => {
      mockBashInstance.exec.mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 12,
          params: { name: "run_bash", arguments: { script: "true" } },
        });
        const response = parseResponse(capture.output[0]);
        expect(response.result.content[0].text).toBe("(No output)");
        expect(response.result.isError).toBe(false);
      } finally {
        capture.restore();
      }
    });

    it("includes both stdout and stderr when both present", async () => {
      mockBashInstance.exec.mockResolvedValue({
        stdout: "partial output",
        stderr: "warning message",
        exitCode: 1,
      });
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 13,
          params: { name: "run_bash", arguments: { script: "mixed" } },
        });
        const response = parseResponse(capture.output[0]);
        expect(response.result.content[0].text).toContain("partial output");
        expect(response.result.content[0].text).toContain("warning message");
        expect(response.result.isError).toBe(true);
      } finally {
        capture.restore();
      }
    });

    it("handles missing script argument gracefully", async () => {
      mockBashInstance.exec.mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 14,
          params: { name: "run_bash", arguments: {} },
        });
        const response = parseResponse(capture.output[0]);
        expect(mockBashInstance.exec).toHaveBeenCalledWith("", {
          persistState: true,
        });
        expect(response.result.content[0].text).toBe("(No output)");
      } finally {
        capture.restore();
      }
    });
  });

  describe("tools/call - get_state", () => {
    it("returns cwd and environment variables", async () => {
      mockBashInstance.getCwd.mockReturnValue("/home/user");
      mockBashInstance.getEnv.mockReturnValue({
        PATH: "/usr/bin",
        HOME: "/home/user",
      });
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 20,
          params: { name: "get_state", arguments: {} },
        });
        const response = parseResponse(capture.output[0]);
        const state = JSON.parse(response.result.content[0].text);
        expect(state.cwd).toBe("/home/user");
        expect(state.env.PATH).toBe("/usr/bin");
        expect(state.env.HOME).toBe("/home/user");
      } finally {
        capture.restore();
      }
    });
  });

  describe("tools/call - snapshot", () => {
    it("returns base64-encoded snapshot state", async () => {
      const snapshotData = { files: {}, env: { FOO: "bar" } };
      mockBashInstance.snapshot.mockResolvedValue(snapshotData);
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 30,
          params: { name: "snapshot", arguments: {} },
        });
        const response = parseResponse(capture.output[0]);
        const decoded = JSON.parse(
          Buffer.from(response.result.content[0].text, "base64").toString(
            "utf-8",
          ),
        );
        expect(decoded).toEqual(snapshotData);
      } finally {
        capture.restore();
      }
    });
  });

  describe("tools/call - restore", () => {
    it("restores state from base64-encoded snapshot", async () => {
      mockBashInstance.restore.mockResolvedValue(undefined);
      const snapshotData = { files: {}, env: { BAZ: "qux" } };
      const encoded = Buffer.from(JSON.stringify(snapshotData)).toString(
        "base64",
      );
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 31,
          params: { name: "restore", arguments: { snapshot: encoded } },
        });
        const response = parseResponse(capture.output[0]);
        expect(response.result.content[0].text).toBe(
          "State restored successfully.",
        );
        expect(mockBashInstance.restore).toHaveBeenCalledWith(snapshotData);
      } finally {
        capture.restore();
      }
    });
  });

  describe("tools/call - create_delta", () => {
    it("creates and returns base64-encoded delta", async () => {
      const baseData = { files: {}, env: {} };
      const deltaData = { added: { "/tmp/new": "content" }, removed: [] };
      mockBashInstance.createDelta.mockResolvedValue(deltaData);
      const encodedBase = Buffer.from(JSON.stringify(baseData)).toString(
        "base64",
      );
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 32,
          params: {
            name: "create_delta",
            arguments: { baseSnapshot: encodedBase },
          },
        });
        const response = parseResponse(capture.output[0]);
        const decoded = JSON.parse(
          Buffer.from(response.result.content[0].text, "base64").toString(
            "utf-8",
          ),
        );
        expect(decoded).toEqual(deltaData);
        expect(mockBashInstance.createDelta).toHaveBeenCalledWith(baseData);
      } finally {
        capture.restore();
      }
    });
  });

  describe("tools/call - apply_delta", () => {
    it("applies delta from base64-encoded input", async () => {
      mockBashInstance.applyDelta.mockResolvedValue(undefined);
      const deltaData = { added: { "/tmp/file": "data" }, removed: [] };
      const encodedDelta = Buffer.from(JSON.stringify(deltaData)).toString(
        "base64",
      );
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 33,
          params: { name: "apply_delta", arguments: { delta: encodedDelta } },
        });
        const response = parseResponse(capture.output[0]);
        expect(response.result.content[0].text).toBe(
          "Delta applied successfully.",
        );
        expect(mockBashInstance.applyDelta).toHaveBeenCalledWith(deltaData);
      } finally {
        capture.restore();
      }
    });
  });

  describe("resources/list", () => {
    it("returns vfs resources with proper URIs", async () => {
      mockBashInstance.fs.getAllPaths.mockReturnValue([
        "/home/user/file.txt",
        "/tmp/data.json",
      ]);
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "resources/list",
          id: 40,
          params: {},
        });
        const response = parseResponse(capture.output[0]);
        expect(response.result.resources).toHaveLength(2);
        expect(response.result.resources[0]).toEqual({
          uri: "ag-bash://vfs/home/user/file.txt",
          name: "/home/user/file.txt",
          mimeType: "text/plain",
        });
        expect(response.result.resources[1]).toEqual({
          uri: "ag-bash://vfs/tmp/data.json",
          name: "/tmp/data.json",
          mimeType: "text/plain",
        });
      } finally {
        capture.restore();
      }
    });

    it("returns empty list when no files exist", async () => {
      mockBashInstance.fs.getAllPaths.mockReturnValue([]);
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "resources/list",
          id: 41,
          params: {},
        });
        const response = parseResponse(capture.output[0]);
        expect(response.result.resources).toEqual([]);
      } finally {
        capture.restore();
      }
    });
  });

  describe("resources/read", () => {
    it("returns file content for valid resource URI", async () => {
      mockBashInstance.fs.readFile.mockResolvedValue("file content here");
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "resources/read",
          id: 50,
          params: { uri: "ag-bash://vfs/home/user/file.txt" },
        });
        const response = parseResponse(capture.output[0]);
        expect(response.result.contents[0].uri).toBe(
          "ag-bash://vfs/home/user/file.txt",
        );
        expect(response.result.contents[0].text).toBe("file content here");
        expect(mockBashInstance.fs.readFile).toHaveBeenCalledWith(
          "/home/user/file.txt",
        );
      } finally {
        capture.restore();
      }
    });

    it("returns error for non-existent resource", async () => {
      mockBashInstance.fs.readFile.mockRejectedValue(
        new Error("ENOENT: no such file"),
      );
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "resources/read",
          id: 51,
          params: { uri: "ag-bash://vfs/nonexistent" },
        });
        const response = parseResponse(capture.output[0]);
        expect(response.error.code).toBe(-32602);
        expect(response.error.message).toContain("Resource not found");
        expect(response.error.message).toContain("/nonexistent");
      } finally {
        capture.restore();
      }
    });
  });

  describe("ping", () => {
    it("returns empty result object", async () => {
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "ping",
          id: 60,
          params: {},
        });
        const response = parseResponse(capture.output[0]);
        expect(response.id).toBe(60);
        expect(response.result).toEqual({});
      } finally {
        capture.restore();
      }
    });
  });

  describe("unknown method", () => {
    it("returns method not found error", async () => {
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "nonexistent/method",
          id: 70,
          params: {},
        });
        const response = parseResponse(capture.output[0]);
        expect(response.error.code).toBe(-32601);
        expect(response.error.message).toBe(
          "Method not found: nonexistent/method",
        );
      } finally {
        capture.restore();
      }
    });
  });

  describe("error handling", () => {
    it("sanitizes file paths from error messages", async () => {
      mockBashInstance.exec.mockRejectedValue(
        new Error("Failed to read /home/user/secret/config.json"),
      );
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 80,
          params: { name: "run_bash", arguments: { script: "cat secret" } },
        });
        const response = parseResponse(capture.output[0]);
        expect(response.error.code).toBe(-32603);
        expect(response.error.message).not.toContain("/home/user/secret");
        expect(response.error.message).toContain("[path]");
      } finally {
        capture.restore();
      }
    });

    it("truncates long error messages to 200 characters", async () => {
      const longMessage = "A".repeat(300);
      mockBashInstance.exec.mockRejectedValue(new Error(longMessage));
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 81,
          params: { name: "run_bash", arguments: { script: "fail" } },
        });
        const response = parseResponse(capture.output[0]);
        expect(response.error.message.length).toBeLessThanOrEqual(203);
        expect(response.error.message).toContain("...");
      } finally {
        capture.restore();
      }
    });

    it("returns generic message for non-Error exceptions", async () => {
      mockBashInstance.exec.mockRejectedValue("string error");
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 82,
          params: { name: "run_bash", arguments: { script: "throw" } },
        });
        const response = parseResponse(capture.output[0]);
        expect(response.error.code).toBe(-32603);
        expect(response.error.message).toBe("Internal server error");
      } finally {
        capture.restore();
      }
    });
  });

  describe("JSON-RPC protocol compliance", () => {
    it("always includes jsonrpc 2.0 in responses", async () => {
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "ping",
          id: 90,
          params: {},
        });
        const response = parseResponse(capture.output[0]);
        expect(response.jsonrpc).toBe("2.0");
      } finally {
        capture.restore();
      }
    });

    it("preserves string request id in response", async () => {
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "ping",
          id: "string-id-42",
          params: {},
        });
        const response = parseResponse(capture.output[0]);
        expect(response.id).toBe("string-id-42");
      } finally {
        capture.restore();
      }
    });

    it("handles null id", async () => {
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "ping",
          id: null,
          params: {},
        });
        const response = parseResponse(capture.output[0]);
        expect(response.id).toBeNull();
      } finally {
        capture.restore();
      }
    });

    it("handles numeric id", async () => {
      const capture = captureStdout();
      try {
        await server.handleRequest({
          jsonrpc: "2.0",
          method: "ping",
          id: 999,
          params: {},
        });
        const response = parseResponse(capture.output[0]);
        expect(response.id).toBe(999);
      } finally {
        capture.restore();
      }
    });
  });
});

describe("sanitizeErrorMessage", () => {
  it("strips unix file paths", () => {
    const result = sanitizeErrorMessage(
      new Error("Cannot open /etc/passwd for reading"),
    );
    expect(result).not.toContain("/etc/passwd");
    expect(result).toContain("[path]");
  });

  it("strips windows file paths", () => {
    const result = sanitizeErrorMessage(
      new Error("Cannot open C:\\Users\\admin\\secret.txt"),
    );
    expect(result).not.toContain("C:\\Users");
    expect(result).toContain("[path]");
  });

  it("truncates messages over 200 characters", () => {
    const result = sanitizeErrorMessage(new Error("x".repeat(250)));
    expect(result.length).toBeLessThanOrEqual(203);
    expect(result.endsWith("...")).toBe(true);
  });

  it("returns generic message for non-Error values", () => {
    expect(sanitizeErrorMessage("string")).toBe("Internal server error");
    expect(sanitizeErrorMessage(42)).toBe("Internal server error");
    expect(sanitizeErrorMessage(null)).toBe("Internal server error");
    expect(sanitizeErrorMessage(undefined)).toBe("Internal server error");
  });

  it("preserves messages under 200 characters without paths", () => {
    const result = sanitizeErrorMessage(new Error("Something went wrong"));
    expect(result).toBe("Something went wrong");
  });
});
