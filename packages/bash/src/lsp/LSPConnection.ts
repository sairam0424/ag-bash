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
    { resolve: Function; reject: Function }
  >();
  private buffer = Buffer.alloc(0);

  constructor(command: string, args: string[]) {
    super();
    this.process = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.process.on("error", (err: any) => {
      // If the language server isn't installed (ENOENT), silence the warning
      // as it's expected in many environments. For other errors, log it.
      if (err.code !== "ENOENT") {
        console.warn(`LSP process error: ${err.message}`);
      }
    });

    this.process.stdout?.on("data", (data) => this.handleData(data));
    this.process.stderr?.on("data", (data) => {
      console.error(`LSP Server Error: ${data.toString()}`);
    });

    this.process.on("exit", (code) => {
      this.emit("exit", code);
    });
  }

  public async sendRequest(method: string, params: any): Promise<any> {
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
      } catch (e) {
        console.error("Failed to parse LSP message", e);
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

  public terminate(): void {
    this.process.kill();
  }
}
