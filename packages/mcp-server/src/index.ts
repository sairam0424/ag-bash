import { Bash } from "@ag-bash/bash";

function sanitizeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Internal server error";
  const msg = error.message;
  // Strip file paths (Unix and Windows)
  const sanitized = msg
    .replace(/\/[\w./\-]+/g, "[path]")
    .replace(/[A-Z]:\\[\w\\.\-]+/g, "[path]");
  // Cap length to prevent information leakage via long stack traces
  return sanitized.length > 200
    ? `${sanitized.slice(0, 200)}...`
    : sanitized;
}

/**
 * Ag-Bash MCP Server (Dependency-Free Implementation)
 *
 * Implements the Model Context Protocol (v2024-11-05) JSON-RPC 2.0 over Stdio.
 * This version avoids external dependencies to ensure reliability in all environments.
 */
class AgBashServer {
  private bash: Bash;
  private readonly protocolVersion = "2024-11-05";

  constructor() {
    // Initialize the persistent Bash engine
    this.bash = new Bash({
      network: {
        dangerouslyAllowFullInternetAccess: true,
      },
      runtimes: { python: true, javascript: true },
      security: { defenseInDepth: true },
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC result or error object
  private sendResponse(id: string | number | null, resultOrError: any) {
    const response = {
      jsonrpc: "2.0",
      id,
      ...resultOrError,
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  // biome-ignore lint/suspicious/noExplicitAny: incoming JSON-RPC request object
  private async handleRequest(request: any) {
    const { method, params, id } = request;

    try {
      switch (method) {
        case "initialize": {
          return this.sendResponse(id, {
            result: {
              protocolVersion: this.protocolVersion,
              capabilities: {
                tools: Object.create(null),
                resources: { subscribe: true },
              },
              serverInfo: {
                name: "ag-bash",
                version: "3.0.0",
              },
            },
          });
        }

        case "notifications/initialized": {
          // No response needed for notifications
          return;
        }

        case "tools/list": {
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
                        description: "The base64 encoded snapshot state to restore.",
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
        }

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
                content: [
                  {
                    type: "text",
                    text: output || "(No output)",
                  },
                ],
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
                      {
                        cwd: this.bash.getCwd(),
                        env: this.bash.getEnv(),
                      },
                      null,
                      2,
                    ),
                  },
                ],
              },
            });
          } else if (name === "snapshot") {
            const state = await this.bash.snapshot();
            const encoded = Buffer.from(JSON.stringify(state)).toString("base64");
            return this.sendResponse(id, {
              result: {
                content: [{ type: "text", text: encoded }],
              },
            });
          } else if (name === "restore") {
            const encodedSnapshot = String(args?.snapshot || "");
            const snapshot = JSON.parse(
              Buffer.from(encodedSnapshot, "base64").toString("utf-8"),
            );
            await this.bash.restore(snapshot);
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
              result: {
                content: [{ type: "text", text: encodedDelta }],
              },
            });
          } else if (name === "apply_delta") {
            const encodedDelta = String(args?.delta || "");
            const delta = JSON.parse(
              Buffer.from(encodedDelta, "base64").toString("utf-8"),
            );
            await this.bash.applyDelta(delta);
            return this.sendResponse(id, {
              result: {
                content: [{ type: "text", text: "Delta applied successfully." }],
              },
            });
          }
          break;
        }

        case "resources/list": {
          const paths = this.bash.fs.getAllPaths();
          return this.sendResponse(id, {
            result: {
              resources: paths.map((p) => ({
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
              result: {
                contents: [{ uri, text: content }],
              },
            });
          } catch (e) {
            return this.sendResponse(id, {
              error: {
                code: -32602,
                message: `Resource not found: ${path}`,
              },
            });
          }
        }

        case "ping": {
          return this.sendResponse(id, { result: {} });
        }
      }

      // Default for unknown methods
      return this.sendResponse(id, {
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      });
    } catch (error) {
      return this.sendResponse(id, {
        error: {
          code: -32603,
          message: sanitizeErrorMessage(error),
        },
      });
    }
  }

  run() {
    process.stdin.on("data", (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const request = JSON.parse(line);
          this.handleRequest(request);
        } catch (e) {
          console.error("Failed to parse JSON-RPC message");
        }
      }
    });

    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));

    console.error(
      "Ag-Bash MCP server running on stdio (V3)",
    );
  }
}

const server = new AgBashServer();
server.run();
