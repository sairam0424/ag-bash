/**
 * Agent Runtime Types
 *
 * Core type definitions for the autonomous agent RunLoop that transforms
 * ag-bash from "bash as a tool" to "bash as an agent runtime."
 */

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

export interface RunLoopConfig {
  llm: LLMProvider;
  systemPrompt: string;
  tools?: ToolSchema[];
  budget?: BudgetConfig;
  onTurn?: (event: TurnEvent) => void;
  signal?: AbortSignal;
}

export interface TurnEvent {
  turnNumber: number;
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    result: string;
    durationMs: number;
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
}
