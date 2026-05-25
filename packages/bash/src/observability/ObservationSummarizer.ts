import type { Observation } from "../types.js";
import type { ToolCallSummary, TurnSummary } from "./types.js";

/**
 * Internal state for an in-progress turn being recorded.
 */
interface ActiveTurn {
  turnId: string;
  startTime: number;
  toolCalls: ToolCallSummary[];
  observations: Observation[];
  filesModified: Set<string>;
  filesRead: Set<string>;
  exitCodes: number[];
  pendingTools: Map<
    string,
    { name: string; args: Record<string, unknown>; startTime: number }
  >;
}

/**
 * ObservationSummarizer records events during an agent "turn" and produces
 * structured TurnSummary objects for LLM context management.
 *
 * Lifecycle:
 *   1. startTurn() — begins recording
 *   2. recordToolStart / recordToolEnd / recordFile* / recordObservation — accumulate data
 *   3. endTurn(turnId) — finalizes and returns the TurnSummary
 *
 * After multiple turns, use getHistory() or compactHistory() for context retrieval.
 */
export class ObservationSummarizer {
  private history: TurnSummary[] = [];
  private activeTurn: ActiveTurn | null = null;
  private turnCounter = 0;

  /** Maximum number of turns retained in history before eviction. */
  private static readonly MAX_HISTORY_SIZE = 200;

  /** Maximum length for result previews in tool call summaries. */
  private static readonly MAX_PREVIEW_LENGTH = 200;

  /** Approximate characters per token for estimation. */
  private static readonly CHARS_PER_TOKEN = 4;

  /** Start recording a new turn. Returns the turnId. */
  startTurn(): string {
    const turnId = `turn-${++this.turnCounter}`;
    this.activeTurn = {
      turnId,
      startTime: Date.now(),
      toolCalls: [],
      observations: [],
      filesModified: new Set(),
      filesRead: new Set(),
      exitCodes: [],
      pendingTools: new Map(),
    };
    return turnId;
  }

  /** Record that a tool call started. */
  recordToolStart(
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): void {
    if (!this.activeTurn) return;
    this.activeTurn.pendingTools.set(callId, {
      name,
      args,
      startTime: Date.now(),
    });
  }

  /** Record that a tool call completed. */
  recordToolEnd(callId: string, result: unknown, exitCode: number): void {
    if (!this.activeTurn) return;
    const pending = this.activeTurn.pendingTools.get(callId);
    if (!pending) return;
    this.activeTurn.pendingTools.delete(callId);

    const durationMs = Date.now() - pending.startTime;
    const resultStr =
      typeof result === "string" ? result : JSON.stringify(result);
    const resultPreview =
      resultStr.length > ObservationSummarizer.MAX_PREVIEW_LENGTH
        ? `${resultStr.slice(0, ObservationSummarizer.MAX_PREVIEW_LENGTH)}...`
        : resultStr;

    this.activeTurn.toolCalls.push({
      name: pending.name,
      args: pending.args,
      status: exitCode === 0 ? "success" : "error",
      durationMs,
      resultPreview,
    });
    this.activeTurn.exitCodes.push(exitCode);
  }

  /** Record a file read event. */
  recordFileRead(path: string): void {
    if (!this.activeTurn) return;
    this.activeTurn.filesRead.add(path);
  }

  /** Record a file modification event. */
  recordFileModified(path: string): void {
    if (!this.activeTurn) return;
    this.activeTurn.filesModified.add(path);
  }

  /** Record an observation (from the Observation type). */
  recordObservation(obs: Observation): void {
    if (!this.activeTurn) return;
    this.activeTurn.observations.push(obs);
  }

  /** End the current turn and produce a summary. */
  endTurn(turnId: string): TurnSummary {
    if (!this.activeTurn || this.activeTurn.turnId !== turnId) {
      throw new Error(`No active turn with id ${turnId}`);
    }

    const turn = this.activeTurn;
    const durationMs = Date.now() - turn.startTime;

    const digest = this.buildDigest(turn);
    const estimatedTokens = Math.ceil(
      digest.length / ObservationSummarizer.CHARS_PER_TOKEN,
    );

    const summary: TurnSummary = {
      turnId: turn.turnId,
      timestamp: turn.startTime,
      durationMs,
      toolCalls: turn.toolCalls,
      observations: turn.observations,
      filesModified: Array.from(turn.filesModified),
      filesRead: Array.from(turn.filesRead),
      exitCodes: turn.exitCodes,
      digest,
      estimatedTokens,
    };

    this.history.push(summary);
    if (this.history.length > ObservationSummarizer.MAX_HISTORY_SIZE) {
      this.history.shift();
    }
    this.activeTurn = null;
    return summary;
  }

  /** Get the last N turn summaries. Returns a copy. */
  getHistory(count?: number): TurnSummary[] {
    if (count === undefined) return [...this.history];
    return this.history.slice(-count);
  }

  /** Compact old summaries into a single digest string for context retention. */
  compactHistory(maxTokens: number): string {
    const summaries: string[] = [];
    let tokens = 0;

    // Start from most recent, working backwards
    for (let i = this.history.length - 1; i >= 0; i--) {
      const turn = this.history[i];
      const line = `[Turn ${turn.turnId}] ${turn.digest}`;
      const lineTokens = Math.ceil(
        line.length / ObservationSummarizer.CHARS_PER_TOKEN,
      );
      if (tokens + lineTokens > maxTokens) break;
      summaries.unshift(line);
      tokens += lineTokens;
    }

    return summaries.join("\n");
  }

  /** Build a human-readable digest from turn activity. */
  private buildDigest(turn: ActiveTurn): string {
    const parts: string[] = [];

    if (turn.toolCalls.length > 0) {
      const succeeded = turn.toolCalls.filter(
        (t) => t.status === "success",
      ).length;
      const failed = turn.toolCalls.filter((t) => t.status === "error").length;
      const toolNames = Array.from(
        new Set(turn.toolCalls.map((t) => t.name)),
      ).join(", ");
      parts.push(
        `Tools: ${toolNames} (${succeeded} ok${failed > 0 ? `, ${failed} failed` : ""})`,
      );
    }

    if (turn.filesModified.size > 0) {
      parts.push(`Modified: ${Array.from(turn.filesModified).join(", ")}`);
    }

    if (turn.filesRead.size > 0) {
      parts.push(`Read: ${Array.from(turn.filesRead).join(", ")}`);
    }

    if (turn.observations.length > 0) {
      const obsTypes = Array.from(
        new Set(turn.observations.map((o) => o.type)),
      ).join(", ");
      parts.push(`Observations: ${obsTypes}`);
    }

    return parts.join(" | ") || "No activity";
  }
}
