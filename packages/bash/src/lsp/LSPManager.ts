import type { Bash } from "../Bash.js";
import { LSPConnection } from "./LSPConnection.js";

export interface LSPRequest {
  method: string;
  params: unknown;
  filePath: string;
}

/**
 * LSPManager - Manages external language servers for advanced code intelligence.
 */
export class LSPManager {
  private connections: Map<string, LSPConnection> = new Map(); // extension -> connection

  /**
   * Initialize a language server for a specific file extension.
   */
  public async initServer(
    extension: string,
    command: string,
    args: string[],
  ): Promise<void> {
    if (this.connections.has(extension)) return;

    try {
      const connection = new LSPConnection(command, args);
      this.connections.set(extension, connection);

      // Standard LSP initialization
      await connection.sendRequest("initialize", {
        processId: process.pid,
        capabilities: {},
        rootUri: null,
      });
      connection.sendNotification("initialized", {});
    } catch (error) {
      // Silently swallow — LSP init failure is non-fatal
    }
  }

  /**
   * Send a request to the appropriate LSP server.
   */
  public async sendRequest(bash: Bash, request: LSPRequest): Promise<unknown> {
    const ext = request.filePath.split(".").pop() || "";
    const connection = this.connections.get(ext);

    if (!connection) {
      // Fallback to internal SemanticEngine if no LSP server is available
      return this.fallbackToSemanticEngine(bash, request);
    }

    try {
      return await connection.sendRequest(request.method, request.params);
    } catch (error) {
      // Silently swallow — caller receives null as the fallback
      return null;
    }
  }

  /**
   * Send a notification to the appropriate LSP server.
   */
  public sendNotification(
    filePath: string,
    method: string,
    params: unknown,
  ): void {
    const ext = filePath.split(".").pop() || "";
    const connection = this.connections.get(ext);
    if (connection) {
      connection.sendNotification(method, params);
    }
  }

  /**
   * Notify the language server that a file has changed.
   */
  public notifyDidChange(filePath: string, content: string): void {
    this.sendNotification(filePath, "textDocument/didChange", {
      textDocument: {
        uri: `file://${filePath}`,
        version: Date.now(), // Simplified versioning
      },
      contentChanges: [{ text: content }],
    });
  }

  private async fallbackToSemanticEngine(
    bash: Bash,
    request: LSPRequest,
  ): Promise<unknown> {
    const engine = bash.semanticEngine;
    if (!engine) return null;

    const params = request.params as Record<string, unknown> | undefined;
    const symbolName = (params?.symbolName as string) || "";

    switch (request.method) {
      case "textDocument/definition":
        return engine.findDefinition(symbolName);
      case "textDocument/references":
        return engine.getOccurrences(symbolName);
      case "textDocument/documentSymbol":
        return engine.getAllSymbols?.() ?? null;
      case "callHierarchy/incomingCalls": {
        const occurrences = engine.getOccurrences(symbolName);
        if (!occurrences) return null;
        return Array.isArray(occurrences) ? occurrences : null;
      }
      default:
        return null;
    }
  }
}
