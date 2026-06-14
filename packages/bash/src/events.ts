/**
 * Typed Event System for Bash
 *
 * Provides type-safe event emission and subscription for tool lifecycle,
 * script execution, and observability hooks.
 */

// ---------------------------------------------------------------------------
// Event Payload Interfaces
// ---------------------------------------------------------------------------

export interface ToolStartEvent {
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface ToolProgressEvent {
  toolName: string;
  message: string;
  progress?: number; // 0-1
  timestamp: number;
}

export interface ToolEndEvent {
  toolName: string;
  duration: number;
  status: "success" | "error";
  resultSummary?: string;
  timestamp: number;
}

export interface ExecStartEvent {
  script: string;
  timestamp: number;
}

export interface ExecEndEvent {
  script: string;
  exitCode: number;
  duration: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Event Map (all known event names → payload types)
// ---------------------------------------------------------------------------

export interface BashEventMap {
  "tool:start": ToolStartEvent;
  "tool:progress": ToolProgressEvent;
  "tool:end": ToolEndEvent;
  "exec:start": ExecStartEvent;
  "exec:end": ExecEndEvent;
}

// ---------------------------------------------------------------------------
// Typed Emitter Interface (environment-agnostic — works in browser + Node)
// ---------------------------------------------------------------------------

export interface TypedEventEmitter<T extends Record<string, unknown>> {
  on<K extends keyof T & string>(event: K, handler: (data: T[K]) => void): this;
  off<K extends keyof T & string>(
    event: K,
    handler: (data: T[K]) => void,
  ): this;
  emit<K extends keyof T & string>(event: K, data: T[K]): boolean;
}
