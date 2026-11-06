import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * LSPConnection - Handles JSON-RPC over stdio for a language server process.
 */
export class LSPConnection extends EventEmitter {
  private process: ChildProcess;
  private idCounter = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
  >();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private failure: Error | undefined;

  constructor(command: string, args: string[]) {
    super();
    this.process = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.process.on("error", (err: unknown) => {
      // A language server that isn't installed (ENOENT) is expected in many
      // environments, so the error is never printed. It is recorded so that
      // requests waiting on this connection are released instead of hanging.
      this.fail(err instanceof Error ? err : new Error(String(err)));
    });

    this.process.stdout?.on("data", (data) => this.handleData(data));
    this.process.stderr?.on("data", () => {
      // Silently swallow LSP stderr — library must not write to consumer's console
    });

    this.process.on("exit", (code) => {
      this.emit("exit", code);
    });
  }

  /** False once the server failed to start or the connection was closed. */
  public get isAvailable(): boolean {
    return !this.closed && this.failure === undefined;
  }

  public async sendRequest(method: string, params: any): Promise<any> {
    if (!this.isAvailable) {
      throw this.failure ?? new Error("LSP connection is closed");
    }
    const id = this.idCounter++;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.writeMessage(message);
    });
  }

  public sendNotification(method: string, params: any): void {
    const message = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.writeMessage(message);
  }

  private writeMessage(message: any): void {
    if (this.closed) return;
    const json = JSON.stringify(message);
    const contentLength = Buffer.byteLength(json, "utf-8");
    const header = `Content-Length: ${contentLength}\r\n\r\n`;
    this.process.stdin?.write(header + json);
  }

  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (true) {
      const content = this.buffer.toString("utf-8");
      const contentLengthMatch = content.match(/Content-Length: (\d+)\r\n\r\n/);

      if (!contentLengthMatch) break;

      const headerLength = contentLengthMatch[0].length;
      const contentLength = parseInt(contentLengthMatch[1], 10);

      if (this.buffer.length < headerLength + contentLength) break;

      const messageJson = this.buffer.toString(
        "utf-8",
        headerLength,
        headerLength + contentLength,
      );
      this.buffer = this.buffer.subarray(headerLength + contentLength);

      try {
        const message = JSON.parse(messageJson);
        this.handleMessage(message);
      } catch (_e) {
        // Silently swallow malformed LSP message
      }
    }
  }

  private handleMessage(message: any): void {
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(message.error);
        } else {
          pending.resolve(message.result);
        }
      }
    } else {
      this.emit("notification", message);
    }
  }

  /**
   * Close the connection and release everything it holds: requests still
   * waiting for a reply are rejected (no caller is left waiting on an answer
   * that can no longer arrive), the stdio pipes are destroyed and the server is
   * sent SIGTERM. Safe to call more than once.
   */
  public terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error("LSP connection is closed"));
    this.process.stdin?.destroy();
    this.process.stdout?.destroy();
    this.process.stderr?.destroy();
    this.process.kill();
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.rejectPending(error);
  }

  private rejectPending(reason: Error): void {
    const waiting = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const request of waiting) {
      request.reject(reason);
    }
  }
}
