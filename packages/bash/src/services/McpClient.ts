/**
 * McpClient - Model Context Protocol Client for Ag-Bash
 */

import type { CommandContext } from "../types.js";

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
  transport: McpTransport;
}

export interface McpTransport {
  init(): Promise<void>;
  send(message: any): Promise<any>;
  close(): void;
}

class HttpTransport implements McpTransport {
  constructor(private url: string) {}
  async init(): Promise<void> {}
  async send(message: any): Promise<any> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    return await response.json();
  }
  close(): void {}
}

class StdioTransport implements McpTransport {
  private process: any;
  private pendingRequests: Map<number | string, (res: any) => void> = new Map();
  private nextId = 1;

  constructor(
    private command: string,
    private args: string[],
  ) {}

  async init(): Promise<void> {
    const { spawn } = await import("node:child_process");
    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "inherit"],
    });

    let buffer = "";
    this.process.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        try {
          const response = JSON.parse(line);
          if (response.id !== undefined) {
            const resolve = this.pendingRequests.get(response.id);
            if (resolve) {
              resolve(response);
              this.pendingRequests.delete(response.id);
            }
          }
        } catch (e) {
          console.error("[McpClient] Error parsing JSON-RPC response:", e);
        }
      }
    });
  }

  async send(message: any): Promise<any> {
    if (!this.process)
      throw new Error("Transport not initialized. Call init() first.");
    const id = this.nextId++;
    message.id = id;
    message.jsonrpc = "2.0";

    return new Promise((resolve) => {
      this.pendingRequests.set(id, resolve);
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  close(): void {
    if (this.process) {
      this.process.kill();
    }
  }
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

  async connectStdio(
    id: string,
    command: string,
    args: string[],
    cmdCtx: CommandContext,
  ): Promise<McpServerConnection> {
    const bash = cmdCtx.bash;
    if (bash && this.connections.size >= bash.limits.maxMcpServers) {
      throw new Error(
        `Maximum MCP servers reached (${bash.limits.maxMcpServers})`,
      );
    }

    const transport = new StdioTransport(command, args);
    await transport.init();

    const connection: McpServerConnection = {
      id,
      name: id,
      type: "stdio",
      status: "connected",
      tools: [],
      transport,
    };

    this.connections.set(id, connection);
    await this.discoverTools(id);
    return connection;
  }

  async connectHttp(
    id: string,
    url: string,
    bash?: any,
  ): Promise<McpServerConnection> {
    if (bash && this.connections.size >= bash.limits.maxMcpServers) {
      throw new Error(
        `Maximum MCP servers reached (${bash.limits.maxMcpServers})`,
      );
    }

    const transport = new HttpTransport(url);
    await transport.init();

    const connection: McpServerConnection = {
      id,
      name: id,
      type: "http",
      status: "connected",
      tools: [],
      transport,
    };

    this.connections.set(id, connection);
    await this.discoverTools(id);
    return connection;
  }

  private async discoverTools(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;

    const response = await conn.transport.send({
      method: "list_tools",
      params: {},
    });

    if (response.result?.tools) {
      conn.tools = response.result.tools;
    }
  }

  async callTool(
    connectionId: string,
    toolName: string,
    args: any,
    bash?: any,
  ): Promise<any> {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error(`Connection ${connectionId} not found`);

    if (bash) {
      const state = (bash as any).state;
      if (state.mcpToolCallCount >= bash.limits.maxMcpToolCalls) {
        throw new Error(
          `Maximum MCP tool calls reached (${bash.limits.maxMcpToolCalls})`,
        );
      }
      state.mcpToolCallCount++;
    }

    const response = await conn.transport.send({
      method: "call_tool",
      params: { name: toolName, arguments: args },
    });

    if (response.error) {
      throw new Error(response.error.message || "Unknown MCP error");
    }

    return response.result;
  }

  listConnections(): McpServerConnection[] {
    return Array.from(this.connections.values());
  }

  disconnect(id: string): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.transport.close();
      this.connections.delete(id);
    }
  }
}
