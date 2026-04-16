import { Bash } from "../../bash/src/index.js";

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
      python: true,
      javascript: true,
      defenseInDepth: true,
    });
  }

   // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC result or error object
  private sendResponse(id: string | number | null, resultOrError: any) {
    const response = {
      jsonrpc: "2.0",
      id,
      ...resultOrError,
    };
    process.stdout.write(JSON.stringify(response) + "\n");
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
                tools: {},
              },
              serverInfo: {
                name: "ag-bash",
                version: "1.0.0",
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
                    properties: {},
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
          }
          break;
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
          message: error instanceof Error ? error.message : String(error),
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
          console.error("Failed to parse JSON-RPC message", e);
        }
      }
    });

    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));

    console.error(
      "Ag-Bash MCP server running on stdio (V2 Custom Implementation)",
    );
  }
}

const server = new AgBashServer();
server.run();
