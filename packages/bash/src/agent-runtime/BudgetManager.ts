/**
 * BudgetManager - Tracks token usage, turn count, and wall-clock time
 * to enforce resource limits on the agent RunLoop.
 *
 * Note: Budget is a soft limit — the last LLM response may push usage
 * over the configured maximum by up to one response size. The check runs
 * before each LLM call, not after.
 */

import type { BudgetConfig } from "./types.js";

export class BudgetManager {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private turnCount = 0;
  private readonly startTime: number;
  private readonly config: BudgetConfig;

  constructor(config: BudgetConfig) {
    this.config = config;
    this.startTime = Date.now();
  }

  recordUsage(inputTokens: number, outputTokens: number): void {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.turnCount++;
  }

  isExhausted(): boolean {
    if (
      this.config.maxTokens !== undefined &&
      this.totalTokens >= this.config.maxTokens
    ) {
      return true;
    }
    if (
      this.config.maxTurns !== undefined &&
      this.turnCount >= this.config.maxTurns
    ) {
      return true;
    }
    if (
      this.config.maxWallClockMs !== undefined &&
      this.elapsedMs >= this.config.maxWallClockMs
    ) {
      return true;
    }
    return false;
  }

  get totalTokens(): number {
    return this.totalInputTokens + this.totalOutputTokens;
  }

  get elapsedMs(): number {
    return Date.now() - this.startTime;
  }

  get turns(): number {
    return this.turnCount;
  }

  getStats(): {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    turns: number;
    elapsedMs: number;
  } {
    return {
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalTokens: this.totalTokens,
      turns: this.turnCount,
      elapsedMs: this.elapsedMs,
    };
  }
}
