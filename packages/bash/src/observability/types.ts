import type { Observation } from "../types.js";

/**
 * Summary of a single tool call within a turn.
 */
export interface ToolCallSummary {
  name: string;
  args: Record<string, unknown>;
  status: "success" | "error";
  durationMs: number;
  resultPreview: string;
}

/**
 * Structured summary of a complete agent turn.
 * Used for LLM context management and history compaction.
 */
export interface TurnSummary {
  turnId: string;
  timestamp: number;
  durationMs: number;
  toolCalls: ToolCallSummary[];
  observations: Observation[];
  filesModified: string[];
  filesRead: string[];
  exitCodes: number[];
  digest: string;
  estimatedTokens: number;
}
