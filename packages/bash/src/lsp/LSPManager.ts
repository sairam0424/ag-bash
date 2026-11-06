import type { Bash } from "../Bash.js";
import { LSPConnection } from "./LSPConnection.js";

export interface LSPRequest {
  method: string;
  params: unknown;
  filePath: string;
}

/** How to start the language server for a file extension. */
interface LSPServerSpec {
  command: string;
  args: string[];
}

/**
 * LSPManager - Manages external language servers for advanced code intelligence.
 *
 * Servers are started on demand. {@link registerServer} only declares one; it
 * is spawned the first time a request needs it (concurrent first requests share
 * a single start) and is closed again by {@link dispose}. Until then a manager
 * holds no process, pipe or pending request.
 */
export class LSPManager {
  private connections: Map<string, LSPConnection> = new Map(); // extension -> connection
  private declared: Map<string, LSPServerSpec> = new Map(); // extension -> server to start on first use
  private starts: Map<string, Promise<void>> = new Map(); // extension -> start still waiting for its initialize reply
  private generation = 0; // bumped by dispose(): a request that began in an older generation was cancelled

  /**
   * Declare the language server for a file extension without starting it.
   * Like {@link initServer}, the first declaration for an extension wins.
   */
  public registerServer(
    extension: string,
    command: string,
    args: string[],
  ): void {
    if (this.declared.has(extension)) return;
    this.declared.set(extension, { command, args });
  }

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
        capabilities: Object.create(null),
        rootUri: null,
      });
      connection.sendNotification("initialized", Object.create(null));
    } catch (_error) {
      // Silently swallow — LSP init failure is non-fatal
    }
  }

  /**
   * Send a request to the appropriate LSP server.
   */
  public async sendRequest(bash: Bash, request: LSPRequest): Promise<unknown> {
    const ext = request.filePath.split(".").pop() || "";
    const generation = this.generation;
    await this.ensureServer(ext);
    // If dispose() ran while this request was waiting for the start, the
    // request was cancelled. The map may by now hold a newer server that was
    // started for callers who arrived after dispose(); it is still mid-handshake
    // and is not ours to use, so a cancelled request falls back instead.
    const connection =
      generation === this.generation ? this.connections.get(ext) : undefined;

    if (!connection?.isAvailable) {
      // Fallback to internal SemanticEngine if no LSP server is available
      return this.fallbackToSemanticEngine(bash, request);
    }

    try {
      return await connection.sendRequest(request.method, request.params);
    } catch (_error) {
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

  /**
   * Close every language server this manager started, and cancel starts that
   * are still waiting for their initialize reply (their callers are released
   * with the semantic-engine fallback). Declarations are kept, so a later
   * request starts a fresh server. Safe to call repeatedly.
   */
  public dispose(): void {
    const open = [...this.connections.values()];
    this.generation++;
    this.connections.clear();
    this.starts.clear();
    for (const connection of open) {
      connection.terminate();
    }
  }

  /**
   * Make sure the server declared for `extension` is running. Resolves once its
   * initialize handshake has finished; every caller that arrives while it is
   * still in flight waits on the same start. Resolves immediately when nothing
   * is declared for the extension or its server is already up.
   */
  private ensureServer(extension: string): Promise<void> | undefined {
    if (this.connections.has(extension)) return this.starts.get(extension);

    const server = this.declared.get(extension);
    if (!server) return undefined;

    const start = this.initServer(extension, server.command, server.args);
    this.starts.set(extension, start);
    const finished = (): void => {
      // A dispose() followed by a new start may have replaced this entry.
      if (this.starts.get(extension) === start) this.starts.delete(extension);
    };
    void start.then(finished, finished);
    return start;
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
