/**
 * Streaming Execution Types
 *
 * Defines the data structures for incremental output delivery
 * from long-running bash commands.
 */

export interface OutputChunk {
  type: "stdout" | "stderr" | "exit";
  data: string;
  timestamp: number;
}

export interface StreamExecOptions {
  /** Environment variables for this execution only. */
  env?: Record<string, string>;
  /** Working directory for this execution only. */
  cwd?: string;
  /** Timeout in milliseconds (default: 30000). */
  timeout?: number;
  /** Abort signal for cooperative cancellation. */
  signal?: AbortSignal;
}
