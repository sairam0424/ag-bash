import { Bash } from "@ag-bash/bash";
import { validateSnapshot, validateDelta } from "./schemas.js";
import { McpToolBridge } from "./tool-bridge.js";
import { RateLimiter } from "./rate-limiter.js";

function sanitizeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Internal server error";
  const msg = error.message;
  // Strip file paths (Unix and Windows)
  const sanitized = msg
    .replace(/\/[\w./-]+/g, "[path]")
    .replace(/[A-Z]:\\[\w\\.-]+/g, "[path]");
  // Cap length to prevent information leakage via long stack traces
  return sanitized.length > 200 ? `${sanitized.slice(0, 200)}...` : sanitized;
}

/** Maximum JSON-RPC request size (16MB) */
const MAX_REQUEST_SIZE = 16 * 1024 * 1024;

/** Maximum base64 encoded payload length (~16MB decoded) */
const MAX_BASE64_LENGTH = 22_000_000;

/**
 * Ag-Bash MCP Server (Dependency-Free Implementation)
 *
 * Implements the Model Context Protocol (v2024-11-05) JSON-RPC 2.0 over Stdio.
 * This version avoids external dependencies to ensure reliability in all environments.
 */
class AgBashServer {
  private bash: Bash;
  private toolBridge: McpToolBridge;
  private rateLimiter: RateLimiter;
  private readonly protocolVersion = "2024-11-05";

  constructor() {
    // Initialize the persistent Bash engine
    this.bash = new Bash({
      network: {
        dangerouslyAllowFullInternetAccess: true,
        denyPrivateRanges: true,
      },
      runtimes: { python: true, javascript: true },
      security: { defenseInDepth: true },
    });

    // Initialize the tool bridge for BashToolbox tools
    this.toolBridge = new McpToolBridge(this.bash);

    // Initialize rate limiter (60 requests per minute)
    this.rateLimiter = new RateLimiter(60, 60_000);
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

  private getPromptMessages(
    name: string,
    args: Record<string, string>,
  ): Array<{ role: string; content: { type: string; text: string } }> | null {
    switch (name) {
      case "explain-script":
        return [
          {
            role: "user",
            content: {
              type: "text",
              text: `Explain what this bash script does, step by step:\n\n${args.script}`,
            },
          },
        ];

      case "fix-error":
        return [
          {
            role: "user",
            content: {
              type: "text",
              text: `The following bash script produced an error. Suggest how to fix it.\n\nScript:\n${args.script}\n\nError:\n${args.error}`,
            },
          },
        ];

      case "optimize-script":
        return [
          {
            role: "user",
            content: {
              type: "text",
              text: `Suggest performance improvements for this bash script. Focus on reducing subshell spawns, unnecessary forks, and inefficient patterns:\n\n${args.script}`,
            },
          },
        ];

      case "security-audit":
        return [
          {
            role: "user",
            content: {
              type: "text",
              text: `Audit this bash script for security issues. Check for command injection, unquoted variables, unsafe temp files, and privilege escalation risks:\n\n${args.script}`,
            },
          },
        ];

      default:
        return null;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: incoming JSON-RPC request object
  private async handleRequest(request: any) {
    const { method, params, id } = request;

    if (typeof method !== "string") {
      return this.sendResponse(id ?? null, {
        error: { code: -32600, message: "Invalid Request: method must be a string" },
      });
    }

    try {
      switch (method) {
        case "initialize": {
          return this.sendResponse(id, {
            result: {
              protocolVersion: this.protocolVersion,
              capabilities: {
                tools: Object.create(null),
                resources: { subscribe: true },
                prompts: Object.create(null),
              },
              serverInfo: {
                name: "ag-bash",
                version: "5.0.0",
              },
            },
          });
        }

        case "notifications/initialized": {
          // No response needed for notifications
          return;
        }

        case "tools/list": {
          // Native low-level tools
          const nativeTools = [
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
          ];

          // Bridge tools from BashToolbox (40+ agentic tools)
          const bridgeTools = this.toolBridge.listTools();

          return this.sendResponse(id, {
            result: {
              tools: [...nativeTools, ...bridgeTools],
            },
          });
        }

        case "tools/call": {
          // Rate limiting check
          if (!this.rateLimiter.allow()) {
            return this.sendResponse(id, {
              result: {
                content: [
                  {
                    type: "text",
                    text: "Rate limit exceeded. Please wait before making more requests.",
                  },
                ],
                isError: true,
              },
            });
          }

          const { name, arguments: args } = params;

          // --- Native low-level tools ---
          if (name === "run_bash") {
            const script = String(args?.script || "");
            const result = await this.bash.exec(script, { persistState: true });

            let output = "";
            if (result.stdout) output += result.stdout;
            if (result.stderr) output += `\nError:\n${result.stderr}`;

            const MAX_OUTPUT_LENGTH = 1_048_576; // 1MB
            if (output.length > MAX_OUTPUT_LENGTH) {
              output = `${output.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated at 1MB]`;
            }

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
            const encoded = Buffer.from(JSON.stringify(state)).toString(
              "base64",
            );
            return this.sendResponse(id, {
              result: {
                content: [{ type: "text", text: encoded }],
              },
            });
          } else if (name === "restore") {
            const encodedSnapshot = String(args?.snapshot || "");
            if (encodedSnapshot.length > MAX_BASE64_LENGTH) {
              return this.sendResponse(id, { error: { code: -32602, message: "Payload too large" } });
            }
            const parsed = JSON.parse(
              Buffer.from(encodedSnapshot, "base64").toString("utf-8"),
            );
            try {
              validateSnapshot(parsed);
            } catch (validationError) {
              return this.sendResponse(id, {
                result: {
                  content: [
                    {
                      type: "text",
                      text: `Validation failed: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
                    },
                  ],
                  isError: true,
                },
              });
            }
            await this.bash.restore(parsed);
            return this.sendResponse(id, {
              result: {
                content: [
                  { type: "text", text: "State restored successfully." },
                ],
              },
            });
          } else if (name === "create_delta") {
            const encodedBase = String(args?.baseSnapshot || "");
            if (encodedBase.length > MAX_BASE64_LENGTH) {
              return this.sendResponse(id, { error: { code: -32602, message: "Payload too large" } });
            }
            const parsedBase = JSON.parse(
              Buffer.from(encodedBase, "base64").toString("utf-8"),
            );
            try {
              validateSnapshot(parsedBase);
            } catch (validationError) {
              return this.sendResponse(id, {
                result: {
                  content: [
                    {
                      type: "text",
                      text: `Validation failed: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
                    },
                  ],
                  isError: true,
                },
              });
            }
            const delta = await this.bash.createDelta(parsedBase);
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
            if (encodedDelta.length > MAX_BASE64_LENGTH) {
              return this.sendResponse(id, { error: { code: -32602, message: "Payload too large" } });
            }
            const parsedDelta = JSON.parse(
              Buffer.from(encodedDelta, "base64").toString("utf-8"),
            );
            try {
              validateDelta(parsedDelta);
            } catch (validationError) {
              return this.sendResponse(id, {
                result: {
                  content: [
                    {
                      type: "text",
                      text: `Validation failed: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
                    },
                  ],
                  isError: true,
                },
              });
            }
            await this.bash.applyDelta(parsedDelta);
            return this.sendResponse(id, {
              result: {
                content: [
                  { type: "text", text: "Delta applied successfully." },
                ],
              },
            });
          } else if (this.toolBridge.hasTool(name)) {
            // --- Bridge tools from BashToolbox ---
            const bridgeResult = await this.toolBridge.callTool(
              name,
              args || Object.create(null),
            );
            return this.sendResponse(id, {
              result: bridgeResult,
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
          } catch (_e) {
            return this.sendResponse(id, {
              error: {
                code: -32602,
                message: `Resource not found: ${path}`,
              },
            });
          }
        }

        case "prompts/list": {
          return this.sendResponse(id, {
            result: {
              prompts: [
                {
                  name: "explain-script",
                  description: "Explain what a bash script does",
                  arguments: [
                    {
                      name: "script",
                      description: "The bash script to explain",
                      required: true,
                    },
                  ],
                },
                {
                  name: "fix-error",
                  description: "Suggest fixes for a shell error",
                  arguments: [
                    {
                      name: "error",
                      description: "The error message from the shell",
                      required: true,
                    },
                    {
                      name: "script",
                      description:
                        "The bash script that produced the error",
                      required: true,
                    },
                  ],
                },
                {
                  name: "optimize-script",
                  description:
                    "Suggest performance improvements for a bash script",
                  arguments: [
                    {
                      name: "script",
                      description: "The bash script to optimize",
                      required: true,
                    },
                  ],
                },
                {
                  name: "security-audit",
                  description:
                    "Check a bash script for security issues",
                  arguments: [
                    {
                      name: "script",
                      description: "The bash script to audit",
                      required: true,
                    },
                  ],
                },
              ],
            },
          });
        }

        case "prompts/get": {
          const promptName = String(params?.name || "");
          const promptArgs = params?.arguments || Object.create(null);

          const promptMessages = this.getPromptMessages(
            promptName,
            promptArgs,
          );

          if (!promptMessages) {
            return this.sendResponse(id, {
              error: {
                code: -32602,
                message: `Prompt not found: ${promptName}`,
              },
            });
          }

          return this.sendResponse(id, {
            result: { messages: promptMessages },
          });
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
        if (line.length > MAX_REQUEST_SIZE) {
          console.error("JSON-RPC message exceeds maximum allowed size");
          continue;
        }
        try {
          const request = JSON.parse(line);
          this.handleRequest(request);
        } catch (_e) {
          console.error("Failed to parse JSON-RPC message");
        }
      }
    });

    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));

    console.error("Ag-Bash MCP server running on stdio (V3)");
  }
}

const server = new AgBashServer();
server.run();
