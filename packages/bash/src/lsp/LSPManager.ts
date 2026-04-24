import type { Bash } from "../Bash.js";
import { LSPConnection } from "./LSPConnection.js";

export interface LSPRequest {
  method: string;
  params: any;
  filePath: string;
}

/**
 * LSPManager - Manages external language servers for advanced code intelligence.
 */
export class LSPManager {
  private static instance: LSPManager;
  private connections: Map<string, LSPConnection> = new Map(); // extension -> connection

  private constructor() {}

  public static getInstance(): LSPManager {
    if (!LSPManager.instance) {
      LSPManager.instance = new LSPManager();
    }
    return LSPManager.instance;
  }

  /**
   * Initialize a language server for a specific file extension.
   */
  public async initServer(extension: string, command: string, args: string[]): Promise<void> {
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
      console.warn(`Failed to initialize LSP server for ${extension}: ${error}`);
    }
  }

  /**
   * Send a request to the appropriate LSP server.
   */
  public async sendRequest(bash: Bash, request: LSPRequest): Promise<any> {
    const ext = request.filePath.split(".").pop() || "";
    const connection = this.connections.get(ext);

    if (!connection) {
      // Fallback to internal SemanticEngine if no LSP server is available
      return this.fallbackToSemanticEngine(bash, request);
    }

    try {
      return await connection.sendRequest(request.method, request.params);
    } catch (error) {
      console.error(`LSP Request failed: ${error}`);
      return null;
    }
  }

  /**
   * Send a notification to the appropriate LSP server.
   */
  public sendNotification(filePath: string, method: string, params: any): void {
    const ext = filePath.split(".").pop() || "";
    const connection = this.connections.get(ext);
    if (connection) {
      connection.sendNotification(method, params);
    }
  }

  private async fallbackToSemanticEngine(bash: Bash, request: LSPRequest): Promise<any> {
    const engine = bash.semanticEngine;
    if (!engine) return null;

    switch (request.method) {
      case "textDocument/definition":
        // Extract symbol name from position (Simplified)
        return engine.findDefinition(request.params.symbolName || "");
      case "textDocument/references":
        return engine.getOccurrences(request.params.symbolName || "");
      default:
        return null;
    }
  }
}
