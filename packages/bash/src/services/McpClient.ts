/**
 * McpClient - Model Context Protocol Client for Ag-Bash
 *
 * Enables the shell to connect to external tool servers and expose their
 * functionality as bash commands or agentic tools.
 */

import { type CommandContext, ExecResult } from "../types.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: any;
}

export interface McpServerConnection {
  id: string;
  name: string;
  type: "stdio" | "http";
  status: "connected" | "disconnected" | "error";
  tools: McpTool[];
}

export class McpClient {
  private static instance: McpClient;
  private connections: Map<string, McpServerConnection> = new Map();

  private constructor() {}

  static getInstance(): McpClient {
    if (!McpClient.instance) {
      McpClient.instance = new McpClient();
    }
    return McpClient.instance;
  }

  /**
   * Connect to an MCP server via stdio (spawn a process).
   */
  async connectStdio(
    id: string,
    command: string,
    args: string[],
    cmdCtx: CommandContext,
  ): Promise<McpServerConnection> {
    const bash = cmdCtx.bash;
    if (bash) {
      if (this.connections.size >= bash.limits.maxMcpServers) {
        throw new Error(
          `Maximum number of MCP server connections reached (${bash.limits.maxMcpServers})`,
        );
      }
    }

    // Note: In a real implementation, this would spawn a persistent process.
    // For the WASM/Sandbox environment, we might need a specialized bridge.
    console.log(
      `[McpClient] Connecting to stdio server ${id}: ${command} ${args.join(" ")}`,
    );

    const connection: McpServerConnection = {
      id,
      name: id,
      type: "stdio",
      status: "connected",
      tools: [], // Tools would be discovered via JSON-RPC list_tools
    };

    this.connections.set(id, connection);

    // Discovery step (mocked for now)
    await this.discoverTools(id);

    return connection;
  }

  /**
   * Connect to an MCP server via HTTP.
   */
  async connectHttp(
    id: string,
    url: string,
    bash?: any,
  ): Promise<McpServerConnection> {
    if (bash) {
      if (this.connections.size >= bash.limits.maxMcpServers) {
        throw new Error(
          `Maximum number of MCP server connections reached (${bash.limits.maxMcpServers})`,
        );
      }
    }

    console.log(`[McpClient] Connecting to http server ${id}: ${url}`);

    const connection: McpServerConnection = {
      id,
      name: id,
      type: "http",
      status: "connected",
      tools: [],
    };

    this.connections.set(id, connection);
    await this.discoverTools(id);

    return connection;
  }

  /**
   * Discover tools available on a connected server.
   */
  private async discoverTools(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;

    // TODO: Implement JSON-RPC list_tools call
    // For now, adding a placeholder
    conn.tools = [
      {
        name: `${id}_echo`,
        description: `Echoes input from ${id}`,
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
        },
      },
    ];
  }

  /**
   * Call a tool on a specific server.
   */
  async callTool(
    connectionId: string,
    toolName: string,
    args: any,
    bash?: any,
  ): Promise<any> {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error(`Connection ${connectionId} not found`);

    if (bash) {
      // Enforce tool call limit
      const state = (bash as any).state;
      if (state.mcpToolCallCount >= bash.limits.maxMcpToolCalls) {
        throw new Error(
          `Maximum number of MCP tool calls reached (${bash.limits.maxMcpToolCalls})`,
        );
      }
      state.mcpToolCallCount++;
    }

    console.log(
      `[McpClient] Calling tool ${toolName} on ${connectionId} with args:`,
      args,
    );

    // TODO: Implement JSON-RPC call_tool
    return { result: `Response from ${toolName}: ${JSON.stringify(args)}` };
  }

  /**
   * List all active connections and their tools.
   */
  listConnections(): McpServerConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Disconnect from a server.
   */
  disconnect(id: string): void {
    this.connections.delete(id);
  }
}
