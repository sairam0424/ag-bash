/**
 * McpClient - Model Context Protocol Client for Ag-Bash
 */

import type { ChildProcess } from "node:child_process";
import { sanitizeErrorMessage } from "../fs/sanitize-error.js";
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

/** Security configuration for HttpTransport. */
export interface HttpTransportSecurityConfig {
  /** Allow requests to private/internal network addresses. Default: false. */
  allowPrivateNetworks?: boolean;
}

/** Error thrown when an SSRF-blocked URL is detected. */
export class McpTransportSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTransportSecurityError";
  }
}

/**
 * Checks whether a URL targets a private or internal IP address.
 * Used to prevent SSRF attacks via the HttpTransport.
 */
function isPrivateUrl(url: string): boolean {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variants
  if (hostname === "localhost" || hostname === "[::1]") {
    return true;
  }

  // Block IPv6 loopback and private ranges
  if (hostname === "::1") {
    return true;
  }

  // Strip brackets for IPv6
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  // IPv6 private: fc00::/7 covers fc and fd prefixes
  if (bare.startsWith("fc") || bare.startsWith("fd")) {
    return true;
  }

  // IPv6 loopback
  if (bare === "::1") {
    return true;
  }

  // Parse IPv4 octets
  const ipv4Parts = bare.split(".");
  if (ipv4Parts.length === 4) {
    const octets = ipv4Parts.map(Number);
    if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
      return false;
    }
    const [a, b] = octets;

    // 0.0.0.0
    if (a === 0 && b === 0 && octets[2] === 0 && octets[3] === 0) {
      return true;
    }
    // 127.0.0.0/8
    if (a === 127) {
      return true;
    }
    // 10.0.0.0/8
    if (a === 10) {
      return true;
    }
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    // 192.168.0.0/16
    if (a === 192 && b === 168) {
      return true;
    }
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) {
      return true;
    }
  }

  return false;
}

class HttpTransport implements McpTransport {
  private readonly securityConfig: HttpTransportSecurityConfig;

  constructor(
    private url: string,
    securityConfig?: HttpTransportSecurityConfig,
  ) {
    this.securityConfig =
      securityConfig ?? (Object.create(null) as HttpTransportSecurityConfig);
  }

  async init(): Promise<void> {}

  async send(message: unknown): Promise<unknown> {
    if (!this.securityConfig.allowPrivateNetworks && isPrivateUrl(this.url)) {
      throw new McpTransportSecurityError(
        `SSRF blocked: requests to private/internal network addresses are not allowed (${new URL(this.url).hostname})`,
      );
    }

    const response = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    return await response.json();
  }

  close(): void {}
}

/** Configuration options for StdioTransport. */
export interface StdioTransportOptions {
  /** Timeout in milliseconds for pending requests. Default: 30000 (30s). */
  requestTimeoutMs?: number;
}

class StdioTransport implements McpTransport {
  private process: ChildProcess | null = null;
  private pendingRequests: Map<
    number | string,
    { resolve: (res: unknown) => void; reject: (err: Error) => void }
  > = new Map();
  private pendingTimeouts: Map<number | string, ReturnType<typeof setTimeout>> =
    new Map();
  private nextId = 1;
  private readonly requestTimeoutMs: number;

  constructor(
    private command: string,
    private args: string[],
    options?: StdioTransportOptions,
  ) {
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30_000;
  }

  async init(): Promise<void> {
    const { spawn } = await import("node:child_process");
    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "inherit"],
    });

    let buffer = "";
    this.process.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      let newlineIndex: number = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        try {
          const response = JSON.parse(line);
          if (response.id !== undefined) {
            const pending = this.pendingRequests.get(response.id);
            if (pending) {
              const timeout = this.pendingTimeouts.get(response.id);
              if (timeout !== undefined) {
                clearTimeout(timeout);
                this.pendingTimeouts.delete(response.id);
              }
              pending.resolve(response);
              this.pendingRequests.delete(response.id);
            }
          }
        } catch (_e) {
          // Silently swallow malformed JSON-RPC response
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
  }

  async send(message: unknown): Promise<unknown> {
    if (!this.process)
      throw new Error("Transport not initialized. Call init() first.");
    const id = this.nextId++;
    const envelope = Object.assign(Object.create(null), message as object, {
      id,
      jsonrpc: "2.0",
    });

    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      const timeout = setTimeout(() => {
        this.pendingTimeouts.delete(id);
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          pending.reject(
            new Error(
              `MCP request timed out after ${this.requestTimeoutMs}ms (id: ${id})`,
            ),
          );
        }
      }, this.requestTimeoutMs);

      this.pendingTimeouts.set(id, timeout);
      this.process?.stdin?.write(`${JSON.stringify(envelope)}\n`);
    });
  }

  close(): void {
    for (const timeout of this.pendingTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.pendingTimeouts.clear();

    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error("Transport closed while request was pending"));
    }
    this.pendingRequests.clear();

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
    options?: StdioTransportOptions,
  ): Promise<McpServerConnection> {
    const bash = cmdCtx.bash;
    if (bash && this.connections.size >= bash.limits.maxMcpServers) {
      throw new Error(
        `Maximum MCP servers reached (${bash.limits.maxMcpServers})`,
      );
    }

    const transport = new StdioTransport(command, args, options);
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
    securityConfig?: HttpTransportSecurityConfig,
  ): Promise<McpServerConnection> {
    if (bash && this.connections.size >= bash.limits.maxMcpServers) {
      throw new Error(
        `Maximum MCP servers reached (${bash.limits.maxMcpServers})`,
      );
    }

    const transport = new HttpTransport(url, securityConfig);
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
      params: Object.create(null),
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
      throw new Error(
        sanitizeErrorMessage(response.error.message || "Unknown MCP error"),
      );
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

  /** Release all resources and disconnect all servers. */
  async dispose(): Promise<void> {
    for (const conn of this.connections.values()) {
      conn.transport.close();
    }
    this.connections.clear();
  }
}
