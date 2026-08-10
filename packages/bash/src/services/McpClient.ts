/**
 * McpClient - Model Context Protocol Client for Ag-Bash
 */

import type { ChildProcess } from "node:child_process";
import { sanitizeErrorMessage } from "../fs/sanitize-error.js";
import type { ExecutionLimits } from "../limits.js";
import { _clearTimeout, _setTimeout } from "../timers.js";
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

/**
 * Security configuration for the HTTP transport layer.
 * Controls response size limits, redirect behavior, timeouts, and domain restrictions.
 */
export interface HttpTransportSecurityConfig {
  /** Maximum response body size in bytes (default: 52428800 = 50MB) */
  maxResponseBytes?: number;
  /** Redirect policy: "error" rejects redirects, "follow" allows them (default: "error") */
  redirectPolicy?: "error" | "follow";
  /** Request timeout in milliseconds (default: 30000 = 30 seconds) */
  timeoutMs?: number;
  /** Optional list of allowed hostnames. When set, only these domains can be reached. */
  allowedDomains?: string[];
}

/** Default security limits for MCP HTTP transport */
const HTTP_TRANSPORT_DEFAULTS = {
  maxResponseBytes: 52428800, // 50MB
  redirectPolicy: "error" as const,
  timeoutMs: 30000,
} as const;

/**
 * Error thrown when an MCP HTTP transport security check fails.
 */
class McpTransportSecurityError extends Error {
  constructor(reason: string) {
    super(`MCP HTTP transport security error: ${reason}`);
    this.name = "McpTransportSecurityError";
  }
}

class HttpTransport implements McpTransport {
  private readonly maxResponseBytes: number;
  private readonly redirectPolicy: "error" | "follow";
  private readonly timeoutMs: number;
  private readonly allowedDomains: ReadonlySet<string> | null;

  constructor(
    private url: string,
    config?: HttpTransportSecurityConfig,
  ) {
    this.maxResponseBytes =
      config?.maxResponseBytes ?? HTTP_TRANSPORT_DEFAULTS.maxResponseBytes;
    this.redirectPolicy =
      config?.redirectPolicy ?? HTTP_TRANSPORT_DEFAULTS.redirectPolicy;
    this.timeoutMs = config?.timeoutMs ?? HTTP_TRANSPORT_DEFAULTS.timeoutMs;

    if (config?.allowedDomains && config.allowedDomains.length > 0) {
      this.allowedDomains = new Set(
        config.allowedDomains.map((d) => d.toLowerCase()),
      );
    } else {
      this.allowedDomains = null;
    }
  }

  async init(): Promise<void> {}

  async send(message: unknown): Promise<unknown> {
    // --- Domain allowlist enforcement ---
    this.validateDomain(this.url);

    // --- Timeout via AbortController ---
    const controller = new AbortController();
    const timeoutId = _setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
        signal: controller.signal,
        redirect: this.redirectPolicy === "error" ? "error" : "follow",
      });

      // --- Content-Length pre-check (fast path) ---
      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader) {
        const declaredSize = parseInt(contentLengthHeader, 10);
        if (
          !Number.isNaN(declaredSize) &&
          declaredSize > this.maxResponseBytes
        ) {
          throw new McpTransportSecurityError(
            `Response Content-Length (${declaredSize} bytes) exceeds limit (${this.maxResponseBytes} bytes)`,
          );
        }
      }

      // --- Stream response body with size enforcement ---
      const body = response.body;
      if (body) {
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          totalBytes += value.byteLength;
          if (totalBytes > this.maxResponseBytes) {
            reader.cancel();
            throw new McpTransportSecurityError(
              `Response body exceeded size limit (${this.maxResponseBytes} bytes)`,
            );
          }
          chunks.push(value);
        }

        // Decode and parse the accumulated chunks
        const decoder = new TextDecoder();
        const parts: string[] = [];
        for (const chunk of chunks) {
          parts.push(decoder.decode(chunk, { stream: true }));
        }
        parts.push(decoder.decode());
        const text = parts.join("");

        return JSON.parse(text);
      }

      // Fallback: no body stream available (should not happen for POST responses)
      return await response.json();
    } catch (error: unknown) {
      if (error instanceof McpTransportSecurityError) {
        throw error;
      }

      // Wrap AbortError with a clearer message
      if (
        error instanceof Error &&
        error.name === "AbortError"
      ) {
        throw new McpTransportSecurityError(
          `Request timed out after ${this.timeoutMs}ms`,
        );
      }

      // Wrap redirect errors (fetch throws TypeError on redirect: "error")
      if (
        error instanceof TypeError &&
        this.redirectPolicy === "error"
      ) {
        const msg = error.message.toLowerCase();
        if (msg.includes("redirect")) {
          throw new McpTransportSecurityError(
            "Server attempted a redirect, which is blocked by redirect policy",
          );
        }
      }

      throw error;
    } finally {
      _clearTimeout(timeoutId);
    }
  }

  close(): void {}

  /**
   * Validates that the target URL's hostname is in the allowed domains list.
   * @throws McpTransportSecurityError if the domain is not allowed
   */
  private validateDomain(targetUrl: string): void {
    if (this.allowedDomains === null) {
      return;
    }

    let hostname: string;
    try {
      const parsed = new URL(targetUrl);
      hostname = parsed.hostname.toLowerCase();
    } catch {
      throw new McpTransportSecurityError(
        `Invalid URL: ${targetUrl}`,
      );
    }

    if (!this.allowedDomains.has(hostname)) {
      throw new McpTransportSecurityError(
        `Domain "${hostname}" is not in the allowed domains list`,
      );
    }
  }
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
        } catch (_e) {
          // Silently swallow malformed JSON-RPC response
        }
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
      throw new Error(sanitizeErrorMessage(response.error.message) || "Unknown MCP error");
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

  /* ---------------------------------------------------------------- */
  /*  Disposable                                                        */
  /* ---------------------------------------------------------------- */

  private disposed = false;

  /**
   * Disconnect all transports and release resources.
   * Idempotent — safe to call multiple times.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const conn of this.connections.values()) {
      conn.transport.close();
    }
    this.connections.clear();
  }
}
