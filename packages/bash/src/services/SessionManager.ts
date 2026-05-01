import type { Worker } from "node:worker_threads";

export interface SessionSummary {
  id: string;
  type: "javascript" | "python";
  age: number;
  lastUsed: number;
}

export interface SessionInfo {
  id: string;
  type: "javascript" | "python";
  worker: Worker;
  createdAt: number;
  lastUsedAt: number;
}

/**
 * SessionManager manages persistent REPL sessions for JS and Python.
 * It keeps workers alive across multiple tool calls.
 */
export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map();

  createSession(
    type: "javascript" | "python",
    worker: Worker,
    id?: string,
  ): string {
    const sessionId = id || Math.random().toString(36).substring(2, 11);
    this.sessions.set(sessionId, {
      id: sessionId,
      type,
      worker,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    return sessionId;
  }

  getSession(id: string): SessionInfo | undefined {
    const session = this.sessions.get(id);
    if (session) {
      session.lastUsedAt = Date.now();
    }
    return session;
  }

  terminateSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (session) {
      session.worker.terminate();
      this.sessions.delete(id);
      return true;
    }
    return false;
  }

  listSessions(): SessionSummary[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      type: s.type,
      age: Date.now() - s.createdAt,
      lastUsed: Date.now() - s.lastUsedAt,
    }));
  }
}
