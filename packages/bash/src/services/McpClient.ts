/**
 * McpClient - Model Context Protocol Client for Ag-Bash
 */

import type { ChildProcess } from "node:child_process";
import type { ExecutionLimits } from "../limits.js";
import type { CommandContext } from "../types.js";

/**
 * Minimal structural interface describing what McpClient needs from a Bash
 * instance.  Using a narrow interface avoids a circular import on the full
 * Bash class and decouples McpClient from private internals.
 */
interface McpBashLike {
  readonly limits: Required<ExecutionLimits>;
}

/**
 * Internal-only type used to access Bash.state (which is private).
 * Callers pass Bash through an `any`-typed CommandContext.bash, so at runtime
 * the property exists.  This interface keeps the cast narrow and auditable
 * rather than falling back to `any`.
 */
interface McpBashWithState extends McpBashLike {
  state: {
    mcpToolCallCount: number;
  };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
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
  send(message: unknown): Promise<unknown>;
  close(): void;
}

/** Minimal JSON-RPC 2.0 response shape used for internal type narrowing. */
interface JsonRpcResponse {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code?: number; message: string };
}

class HttpTransport implements McpTransport {
  constructor(private url: string) {}
  async init(): Promise<void> {}
  async send(message: unknown): Promise<unknown> {
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
  private process: ChildProcess | null = null;
  private pendingRequests: Map<number | string, (res: unknown) => void> =
    new Map();
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
    this.process.stdout?.on("data", (data: Buffer) => {
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
          // Silently swallow malformed JSON-RPC response
        }
      }
    });
  }

  async send(message: unknown): Promise<unknown> {
    if (!this.process)
      throw new Error("Transport not initialized. Call init() first.");
    const id = this.nextId++;
    const envelope = Object.assign({}, message as object, {
      id,
      jsonrpc: "2.0",
    });

    return new Promise((resolve) => {
      this.pendingRequests.set(id, resolve);
      this.process?.stdin?.write(`${JSON.stringify(envelope)}\n`);
    });
  }

  close(): void {
    if (this.process) {
      this.process.kill();
    }
  }
}

export class McpClient {
  private connections: Map<string, McpServerConnection> = new Map();

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
    bash?: McpBashLike,
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

    const response = (await conn.transport.send({
      method: "list_tools",
      params: {},
    })) as JsonRpcResponse;

    if (response.result?.tools) {
      conn.tools = response.result.tools as McpTool[];
    }
  }

  async callTool(
    connectionId: string,
    toolName: string,
    args: Record<string, unknown>,
    bash?: McpBashLike,
  ): Promise<unknown> {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error(`Connection ${connectionId} not found`);

    if (bash) {
      // Bash.state is private; callers pass Bash via CommandContext.bash
      // (typed as any). Use a narrow structural cast to access the counter.
      const withState = bash as unknown as McpBashWithState;
      if (
        withState.state &&
        withState.state.mcpToolCallCount >= bash.limits.maxMcpToolCalls
      ) {
        throw new Error(
          `Maximum MCP tool calls reached (${bash.limits.maxMcpToolCalls})`,
        );
      }
      if (withState.state) {
        withState.state.mcpToolCallCount++;
      }
    }

    const response = (await conn.transport.send({
      method: "call_tool",
      params: { name: toolName, arguments: args },
    })) as JsonRpcResponse;

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
