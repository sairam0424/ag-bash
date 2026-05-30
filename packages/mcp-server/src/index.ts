import { Bash } from "@ag-bash/bash";
import { runForkSpeculate } from "./fork-speculate.js";
import {
  AckOutput,
  EncodedBlobOutput,
  ForkSpeculateOutput,
  GetStateOutput,
  type JsonSchemaWire,
  RunBashOutput,
  SearchToolsOutput,
  toOutputSchema,
} from "./output-schema.js";
import { LEGACY_PROTOCOL_VERSION, negotiateProtocol } from "./protocol.js";
import { RateLimiter } from "./rate-limiter.js";
import { validateDelta, validateSnapshot } from "./schemas.js";
import { runSearchTools } from "./search-tools.js";
import { McpToolBridge } from "./tool-bridge.js";

/** A native MCP content item. Text is always present for back-compat. */
type McpContentItem =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string };

/** The serialized tool-call result sent back over JSON-RPC. */
interface ToolCallPayload {
  content: McpContentItem[];
  structuredContent?: unknown;
  isError?: boolean;
}

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
  /** Negotiated protocol version (set during `initialize`). */
  private protocolVersion: string = LEGACY_PROTOCOL_VERSION;
  /**
   * Whether the negotiated client speaks structured content (2025-06-18+).
   * Defaults to false so we emit legacy text-only responses until proven otherwise.
   */
  private supportsStructured = false;

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

  /**
   * Build a tool-call result payload. For 2025-06-18 clients we attach
   * `structuredContent` (machine-parseable) alongside the text block; for
   * legacy clients we emit text only. The text block is ALWAYS present so a
   * 2024-11-05 client never sees an unfamiliar field that would break it.
   *
   * @param text - The human/legacy text rendering (already truncated as needed).
   * @param structured - The structured object matching the tool's outputSchema.
   * @param isError - Whether this represents a tool-level error.
   * @param extraContent - Additional content items (e.g. resource_link items).
   */
  private buildToolResult(
    text: string,
    structured: unknown,
    isError?: boolean,
    extraContent?: McpContentItem[],
  ): ToolCallPayload {
    const content: McpContentItem[] = [{ type: "text", text }];
    if (extraContent && extraContent.length > 0) {
      content.push(...extraContent);
    }
    const payload: ToolCallPayload = { content };
    if (this.supportsStructured) {
      payload.structuredContent = structured;
    }
    if (isError) payload.isError = true;
    return payload;
  }

  /**
   * Attach an `outputSchema` to a tool definition only when the negotiated
   * client supports it. Returns the schema or undefined.
   */
  private outputSchemaFor(schema: JsonSchemaWire): JsonSchemaWire | undefined {
    return this.supportsStructured ? schema : undefined;
  }

  /**
   * Decorate an already-shaped {@link McpToolResult} (from a delegated handler
   * like fork_speculate / search_tools / the bridge) into a {@link ToolCallPayload}.
   *
   * The handler's first text block is canonical and always preserved. When the
   * client supports structured content AND the text parses as JSON, we surface
   * that parsed object as `structuredContent`. Optional `resource_link` items
   * are appended for VFS file references.
   */
  private decorateToolResult(
    result: {
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    },
    resourceLinks?: McpContentItem[],
  ): ToolCallPayload {
    const content: McpContentItem[] = result.content.map((c) => ({
      type: "text" as const,
      text: c.text,
    }));
    if (resourceLinks && resourceLinks.length > 0) {
      content.push(...resourceLinks);
    }

    const payload: ToolCallPayload = { content };
    if (result.isError) payload.isError = true;

    if (this.supportsStructured && result.content.length > 0) {
      const firstText = result.content[0].text;
      const parsed = this.tryParseJson(firstText);
      if (parsed !== undefined) {
        payload.structuredContent = parsed;
      }
    }
    return payload;
  }

  /** Safely parse JSON, returning undefined on any failure. */
  private tryParseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /**
   * Compute `resource_link` content items for a bridge tool call.
   *
   * Tools that read or write a VFS file accept a `path` argument; on success we
   * emit a resource_link pointing at the canonical `ag-bash://vfs<path>` URI so
   * the client can resolve it via resources/read. Only emitted for 2025-06-18+
   * clients (resource_link is a 2025-06-18 content type) and only on success.
   */
  private resourceLinksFor(
    name: string,
    args: Record<string, unknown> | undefined,
    isError: boolean | undefined,
  ): McpContentItem[] {
    if (!this.supportsStructured || isError) return [];
    const fileTools = new Set([
      "read_file",
      "write_file",
      "edit_file",
      "append_file",
    ]);
    if (!fileTools.has(name)) return [];
    const rawPath = args?.path;
    if (typeof rawPath !== "string" || rawPath.length === 0) return [];
    return [
      {
        type: "resource_link",
        uri: `ag-bash://vfs${rawPath}`,
        name: rawPath,
        mimeType: "text/plain",
      },
    ];
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
  async handleRequest(request: any): Promise<void> {
    const { method, params, id } = request;

    if (typeof method !== "string") {
      return this.sendResponse(id ?? null, {
        error: {
          code: -32600,
          message: "Invalid Request: method must be a string",
        },
      });
    }

    try {
      switch (method) {
        case "initialize": {
          // Feature-detect the client's protocol revision and degrade
          // gracefully: 2025-06-18 clients get structuredContent + outputSchema
          // + resource_link; 2024-11-05 clients keep serialized-JSON text.
          const negotiated = negotiateProtocol(params?.protocolVersion);
          this.protocolVersion = negotiated.version;
          this.supportsStructured = negotiated.supportsStructured;

          return this.sendResponse(id, {
            result: {
              protocolVersion: this.protocolVersion,
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: true, listChanged: false },
                prompts: { listChanged: false },
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
          // Native low-level tools. `outputSchema` is attached only for
          // 2025-06-18+ clients (via outputSchemaFor); annotations are always
          // present per the MCP tool-annotation spec.
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
              outputSchema: this.outputSchemaFor(toOutputSchema(RunBashOutput)),
              annotations: {
                title: "Run Bash",
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
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
              outputSchema: this.outputSchemaFor(
                toOutputSchema(GetStateOutput),
              ),
              annotations: {
                title: "Get Shell State",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
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
              outputSchema: this.outputSchemaFor(
                toOutputSchema(EncodedBlobOutput),
              ),
              annotations: {
                title: "Snapshot State",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
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
              outputSchema: this.outputSchemaFor(toOutputSchema(AckOutput)),
              annotations: {
                title: "Restore State",
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
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
              outputSchema: this.outputSchemaFor(
                toOutputSchema(EncodedBlobOutput),
              ),
              annotations: {
                title: "Create Delta",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
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
              outputSchema: this.outputSchemaFor(toOutputSchema(AckOutput)),
              annotations: {
                title: "Apply Delta",
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
              },
            },
            {
              name: "fork_speculate",
              description:
                "Fork-speculation: copy-on-write branch the sandbox into N isolated children, run a candidate script sequence in each branch in parallel, and report each branch's output + exit code so you can pick a winner. Branch mutations (env, cwd, files) are invisible to the persistent shell and to each other. Optionally pass keepWinner to commit exactly one winning branch's scripts onto the persistent shell; otherwise the persistent shell is left untouched (all branches discarded).",
              inputSchema: {
                type: "object",
                properties: {
                  branches: {
                    type: "array",
                    description:
                      "Candidate branches to try. Each branch is an array of bash scripts run in order within its own isolated fork.",
                    items: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  keepWinner: {
                    type: "number",
                    description:
                      "Optional 0-based index of the branch to commit onto the persistent shell. Omit to keep none (pure speculation).",
                  },
                },
                required: ["branches"],
              },
              outputSchema: this.outputSchemaFor(
                toOutputSchema(ForkSpeculateOutput),
              ),
              annotations: {
                title: "Fork & Speculate",
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
              },
            },
            {
              name: "search_tools",
              description:
                "Discover which agentic tools are available for a free-text task description (Code Mode). Returns the best-matching tools by relevance so an agent can pick a tool without pre-loading the full catalog.",
              inputSchema: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description:
                      "Free-text description of the task or capability you need.",
                  },
                  limit: {
                    type: "number",
                    description:
                      "Maximum number of matches to return (1-25, default 5).",
                  },
                },
                required: ["query"],
              },
              outputSchema: this.outputSchemaFor(
                toOutputSchema(SearchToolsOutput),
              ),
              annotations: {
                title: "Search Tools",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
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
            let truncatedStdout = result.stdout;
            let truncatedStderr = result.stderr;
            if (output.length > MAX_OUTPUT_LENGTH) {
              output = `${output.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated at 1MB]`;
              truncatedStdout = result.stdout.slice(0, MAX_OUTPUT_LENGTH);
              truncatedStderr = result.stderr.slice(0, MAX_OUTPUT_LENGTH);
            }

            return this.sendResponse(id, {
              result: this.buildToolResult(
                output || "(No output)",
                {
                  stdout: truncatedStdout,
                  stderr: truncatedStderr,
                  exitCode: result.exitCode,
                },
                result.exitCode !== 0,
              ),
            });
          } else if (name === "get_state") {
            const stateObj = {
              cwd: this.bash.getCwd(),
              env: this.bash.getEnv(),
            };
            return this.sendResponse(id, {
              result: this.buildToolResult(
                JSON.stringify(stateObj, null, 2),
                stateObj,
              ),
            });
          } else if (name === "snapshot") {
            const state = await this.bash.snapshot();
            const encoded = Buffer.from(JSON.stringify(state)).toString(
              "base64",
            );
            return this.sendResponse(id, {
              result: this.buildToolResult(encoded, { encoded }),
            });
          } else if (name === "restore") {
            const encodedSnapshot = String(args?.snapshot || "");
            if (encodedSnapshot.length > MAX_BASE64_LENGTH) {
              return this.sendResponse(id, {
                error: { code: -32602, message: "Payload too large" },
              });
            }
            const parsed = JSON.parse(
              Buffer.from(encodedSnapshot, "base64").toString("utf-8"),
            );
            try {
              validateSnapshot(parsed);
            } catch (validationError) {
              const msg = `Validation failed: ${validationError instanceof Error ? validationError.message : String(validationError)}`;
              return this.sendResponse(id, {
                result: this.buildToolResult(
                  msg,
                  { ok: false, message: msg },
                  true,
                ),
              });
            }
            await this.bash.restore(parsed);
            return this.sendResponse(id, {
              result: this.buildToolResult("State restored successfully.", {
                ok: true,
                message: "State restored successfully.",
              }),
            });
          } else if (name === "create_delta") {
            const encodedBase = String(args?.baseSnapshot || "");
            if (encodedBase.length > MAX_BASE64_LENGTH) {
              return this.sendResponse(id, {
                error: { code: -32602, message: "Payload too large" },
              });
            }
            const parsedBase = JSON.parse(
              Buffer.from(encodedBase, "base64").toString("utf-8"),
            );
            try {
              validateSnapshot(parsedBase);
            } catch (validationError) {
              const msg = `Validation failed: ${validationError instanceof Error ? validationError.message : String(validationError)}`;
              return this.sendResponse(id, {
                result: this.buildToolResult(
                  msg,
                  { ok: false, message: msg },
                  true,
                ),
              });
            }
            const delta = await this.bash.createDelta(parsedBase);
            const encodedDelta = Buffer.from(JSON.stringify(delta)).toString(
              "base64",
            );
            return this.sendResponse(id, {
              result: this.buildToolResult(encodedDelta, {
                encoded: encodedDelta,
              }),
            });
          } else if (name === "apply_delta") {
            const encodedDelta = String(args?.delta || "");
            if (encodedDelta.length > MAX_BASE64_LENGTH) {
              return this.sendResponse(id, {
                error: { code: -32602, message: "Payload too large" },
              });
            }
            const parsedDelta = JSON.parse(
              Buffer.from(encodedDelta, "base64").toString("utf-8"),
            );
            try {
              validateDelta(parsedDelta);
            } catch (validationError) {
              const msg = `Validation failed: ${validationError instanceof Error ? validationError.message : String(validationError)}`;
              return this.sendResponse(id, {
                result: this.buildToolResult(
                  msg,
                  { ok: false, message: msg },
                  true,
                ),
              });
            }
            await this.bash.applyDelta(parsedDelta);
            return this.sendResponse(id, {
              result: this.buildToolResult("Delta applied successfully.", {
                ok: true,
                message: "Delta applied successfully.",
              }),
            });
          } else if (name === "fork_speculate") {
            const result = await runForkSpeculate(this.bash, args);
            return this.sendResponse(id, {
              result: this.decorateToolResult(result),
            });
          } else if (name === "search_tools") {
            const result = await runSearchTools(this.bash, args);
            return this.sendResponse(id, {
              result: this.decorateToolResult(result),
            });
          } else if (this.toolBridge.hasTool(name)) {
            // --- Bridge tools from BashToolbox ---
            const bridgeResult = await this.toolBridge.callTool(
              name,
              args || Object.create(null),
            );
            return this.sendResponse(id, {
              result: this.decorateToolResult(
                bridgeResult,
                this.resourceLinksFor(name, args, bridgeResult.isError),
              ),
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
                      description: "The bash script that produced the error",
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
                  description: "Check a bash script for security issues",
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

          const promptMessages = this.getPromptMessages(promptName, promptArgs);

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

export { AgBashServer };

// Auto-start the stdio server in production. Skipped under the test runner so
// the module can be imported and exercised directly (no stdin loop / no
// startup banner). The production esbuild bundle has VITEST unset, so this
// still fires when the binary is executed.
if (!process.env.VITEST) {
  const server = new AgBashServer();
  server.run();
}
