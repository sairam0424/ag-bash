/**
 * Agent Runtime Types
 *
 * Core type definitions for the autonomous agent RunLoop that transforms
 * ag-bash from "bash as a tool" to "bash as an agent runtime."
 */

import type { MemoryScope } from "../services/AgentMemory.js";
import type { Observation } from "../types.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMProvider {
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}

export interface GenerateRequest {
  messages: Message[];
  tools: ToolSchema[];
}

export interface GenerateResponse {
  content?: string;
  toolCalls?: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: { inputTokens: number; outputTokens: number };
}

export interface BudgetConfig {
  maxTokens?: number;
  maxTurns?: number;
  maxWallClockMs?: number;
}

/**
 * Configuration for the RunLoop's self-healing layer. When enabled, the loop
 * invokes the AgenticHealer on a non-zero tool exit to attempt active recovery
 * (re-executing a corrected command on the sandboxed shell) and/or to surface
 * a textual correction suggestion back to the LLM before the next turn.
 */
export interface RunLoopHealerConfig {
  /**
   * Whether the healer is consulted on tool failures. Default: true.
   * When false, failed tool calls pass through unchanged (only observations
   * are still forwarded).
   */
  enabled?: boolean;
  /**
   * Whether the healer may actively re-execute a corrected command on the
   * sandboxed shell (mutating real state). Default: false — by default the
   * healer only SUGGESTS a correction in the tool payload and never mutates
   * shell state behind the agent's back.
   */
  autoFix?: boolean;
  /** Max active re-execution attempts when autoFix is enabled. Default: 2. */
  maxRetries?: number;
}

/**
 * Configuration for cross-turn agent memory. When provided, the RunLoop loads
 * persisted memory at loop start and writes salient per-turn facts (tool
 * outcomes, healing notes) scoped by agentType + scope.
 */
export interface RunLoopMemoryConfig {
  /** Logical agent identity used to scope memory entries. Default: "run-loop". */
  agentType?: string;
  /** Memory scope level. Default: "local". */
  scope?: MemoryScope;
  /**
   * Whether the loop persists salient facts per turn. Default: true when a
   * memory config object is supplied.
   */
  persist?: boolean;
}

export interface RunLoopConfig {
  llm: LLMProvider;
  systemPrompt: string;
  tools?: ToolSchema[];
  budget?: BudgetConfig;
  onTurn?: (event: TurnEvent) => void;
  signal?: AbortSignal;
  /**
   * Initial shell mode. In "plan" mode WRITE tools (bash/run_command, or any
   * tool not in the read-only allowlist) are GATED — queued rather than
   * executed. Read-only tools still run. Default: inherits the Bash instance's
   * current mode.
   */
  mode?: "execute" | "plan";
  /**
   * Tool names considered READ-ONLY. Read-only tools are always permitted (even
   * in plan mode) and may run in parallel. Any tool NOT in this set is treated
   * as a write tool. Defaults to an empty allowlist, meaning the built-in
   * write-tool denylist (bash/run_command) governs gating.
   */
  readOnlyTools?: string[];
  /** Self-healing configuration. Defaults to { enabled: true, autoFix: false }. */
  healer?: RunLoopHealerConfig;
  /** Cross-turn memory configuration. Omit to disable memory persistence. */
  memory?: RunLoopMemoryConfig;
}

/** A single executed (or gated) tool call within a turn. */
export interface ToolCallResult {
  name: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
  toolCallId: string;
  /** Typed observations forwarded from the sandboxed exec result, if any. */
  observations?: Observation[];
  /** True when the tool was blocked by plan-mode gating instead of executed. */
  gated?: boolean;
  /** Healing suggestion surfaced for a failed tool call, if any. */
  healingSuggestion?: string;
}

export interface TurnEvent {
  turnNumber: number;
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    result: string;
    durationMs: number;
    gated?: boolean;
    healingSuggestion?: string;
  }>;
  inputTokens: number;
  outputTokens: number;
  cumulativeTokens: number;
}

export type RunLoopStatus =
  | "completed"
  | "budget_exhausted"
  | "aborted"
  | "error";

export interface RunLoopResult {
  status: RunLoopStatus;
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  finalOutput?: string;
  error?: string;
  /** Number of tool calls gated by plan mode across the run. */
  gatedToolCalls?: number;
  /** Number of tool failures the healer was consulted on. */
  healingAttempts?: number;
}
