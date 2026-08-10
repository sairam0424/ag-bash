import { Bash, VERSION } from "@ag-bash/bash";
import { validateSnapshot, validateDelta } from "./schemas.js";

// ---------------------------------------------------------------------------
// CLI Argument Parsing (zero dependencies)
// ---------------------------------------------------------------------------

interface CliConfig {
  networkAllowList: string[];
  authToken: string | null;
  maxPayloadSize: number;
  noAuth: boolean;
}

function parseCliArgs(argv: string[]): CliConfig {
  const config: CliConfig = {
    networkAllowList: [],
    authToken: null,
    maxPayloadSize: 10_485_760, // 10MB default
    noAuth: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--network-allow" && i + 1 < argv.length) {
      i++;
      const value = argv[i];
      config.networkAllowList = value
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
    } else if (arg === "--auth-token" && i + 1 < argv.length) {
      i++;
      config.authToken = argv[i];
    } else if (arg === "--max-payload-size" && i + 1 < argv.length) {
      i++;
      const parsed = Number.parseInt(argv[i], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        config.maxPayloadSize = parsed;
      }
    } else if (arg === "--no-auth") {
      config.noAuth = true;
    }
  }

  return config;
}

const cliConfig = parseCliArgs(process.argv);

// ---------------------------------------------------------------------------
// Rate Limiter (sliding window, 100 req/s)
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_REQUESTS = 100;
const MAX_CONCURRENT_TOOL_EXECUTIONS = 10;

class RateLimiter {
  private timestamps: number[] = [];
  private concurrentToolCalls = 0;

  isRateLimited(): boolean {
    const now = Date.now();
    // Evict timestamps outside the window
    while (this.timestamps.length > 0 && this.timestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
      return true;
    }
    this.timestamps.push(now);
    return false;
  }

  acquireToolSlot(): boolean {
    if (this.concurrentToolCalls >= MAX_CONCURRENT_TOOL_EXECUTIONS) {
      return false;
    }
    this.concurrentToolCalls++;
    return true;
  }

  releaseToolSlot(): void {
    if (this.concurrentToolCalls > 0) {
      this.concurrentToolCalls--;
    }
  }
}

const rateLimiter = new RateLimiter();

// ---------------------------------------------------------------------------
// Output Truncation
// ---------------------------------------------------------------------------

const MAX_OUTPUT_SIZE = 1_048_576; // 1MB

function truncateOutput(text: string): string {
  if (text.length > MAX_OUTPUT_SIZE) {
    return `${text.slice(0, MAX_OUTPUT_SIZE)}[truncated]`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Ag-Bash MCP Server (Dependency-Free Implementation)
 *
 * Implements the Model Context Protocol (v2024-11-05) JSON-RPC 2.0 over Stdio.
 * This version avoids external dependencies to ensure reliability in all environments.
 */
class AgBashServer {
  private bash: Bash;
  private readonly protocolVersion = "2024-11-05";
  private authenticated = false;

  constructor() {
    // Build network config from CLI allowlist (no full internet access)
    const networkConfig: Record<string, unknown> = Object.create(null);
    if (cliConfig.networkAllowList.length > 0) {
      // Convert domain allowlist to URL prefixes (https only)
      networkConfig.allowedUrlPrefixes = cliConfig.networkAllowList.map(
        (domain) => `https://${domain}`,
      );
    }

    // Initialize the persistent Bash engine with restricted network
    this.bash = new Bash({
      network: networkConfig,
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

    try {
      switch (method) {
        case "initialize": {
          // Authentication gate: validate token if configured
          if (cliConfig.authToken && !cliConfig.noAuth) {
            const clientToken = params?._authToken;
            if (clientToken !== cliConfig.authToken) {
              return this.sendResponse(id, {
                error: {
                  code: -32600,
                  message: "Authentication failed",
                },
              });
            }
          }
          this.authenticated = true;

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
                version: VERSION,
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
        }

        case "tools/call": {
          // Concurrency semaphore: max 10 concurrent tool executions
          if (!rateLimiter.acquireToolSlot()) {
            return this.sendResponse(id, {
              error: {
                code: -32429,
                message: "Too many concurrent tool executions",
              },
            });
          }
          try {
          const { name, arguments: args } = params;
          if (name === "run_bash") {
            const script = String(args?.script || "");
            const execResult = await this.bash.exec(script, { persistState: true });

            let output = "";
            if (execResult.stdout) output += execResult.stdout;
            if (execResult.stderr) output += `\nError:\n${execResult.stderr}`;

            return this.sendResponse(id, {
              result: {
                content: [
                  {
                    type: "text",
                    text: truncateOutput(output || "(No output)"),
                  },
                ],
                isError: execResult.exitCode !== 0,
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
                content: [{ type: "text", text: truncateOutput(encoded) }],
              },
            });
          } else if (name === "restore") {
            const encodedSnapshot = String(args?.snapshot || "");
            const rawSnapshot = JSON.parse(
              Buffer.from(encodedSnapshot, "base64").toString("utf-8"),
            );
            // Validate snapshot schema before passing to engine (throws on malformed input)
            validateSnapshot(rawSnapshot);
            await this.bash.restore(rawSnapshot);
            return this.sendResponse(id, {
              result: {
                content: [
                  { type: "text", text: "State restored successfully." },
                ],
              },
            });
          } else if (name === "create_delta") {
            const encodedBase = String(args?.baseSnapshot || "");
            const rawBase = JSON.parse(
              Buffer.from(encodedBase, "base64").toString("utf-8"),
            );
            // Validate the base snapshot input (throws on malformed input)
            validateSnapshot(rawBase);
            const delta = await this.bash.createDelta(rawBase);
            const encodedDelta = Buffer.from(JSON.stringify(delta)).toString(
              "base64",
            );
            return this.sendResponse(id, {
              result: {
                content: [{ type: "text", text: truncateOutput(encodedDelta) }],
              },
            });
          } else if (name === "apply_delta") {
            const encodedDelta = String(args?.delta || "");
            const rawDelta = JSON.parse(
              Buffer.from(encodedDelta, "base64").toString("utf-8"),
            );
            // Validate delta schema before passing to engine (throws on malformed input)
            validateDelta(rawDelta);
            await this.bash.applyDelta(rawDelta);
            return this.sendResponse(id, {
              result: {
                content: [
                  { type: "text", text: "Delta applied successfully." },
                ],
              },
            });
          }
          break;
          } finally {
            rateLimiter.releaseToolSlot();
          }
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
          const promptArgs = params?.arguments || {};

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

        // Payload size check (before JSON.parse to prevent OOM)
        if (line.length > cliConfig.maxPayloadSize) {
          this.sendResponse(null, {
            error: {
              code: -32600,
              message: `Payload exceeds maximum size of ${cliConfig.maxPayloadSize} bytes`,
            },
          });
          continue;
        }

        // Rate limiting check
        if (rateLimiter.isRateLimited()) {
          this.sendResponse(null, {
            error: {
              code: -32429,
              message: "Rate limited",
            },
          });
          continue;
        }

        try {
          const request = JSON.parse(line);

          // Authentication enforcement: after initialize, all methods require auth
          const isInitialize = request.method === "initialize";
          const isNotification = typeof request.method === "string" && request.method.startsWith("notifications/");
          if (!isInitialize && !isNotification && !this.authenticated) {
            if (cliConfig.authToken && !cliConfig.noAuth) {
              this.sendResponse(request.id ?? null, {
                error: {
                  code: -32600,
                  message: "Authentication required — call initialize first",
                },
              });
              continue;
            }
          }

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
