import type { UIMessage } from "./index.js";

/**
 * Base status of an agent execution
 */
export interface AgentResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
  error?: string;
}

/**
 * Human-in-the-loop interruption payload returned in tool output.
 */
export interface HitlInterruption extends Record<string, unknown> {
  interrupted: true;
  question: string;
}

/**
 * Tool output can be a plain string or a structured object.
 */
export type ToolOutput = string | Record<string, unknown>;

/**
 * Discriminated union of all stream chunk types emitted by an adapter.
 */
export type AgentStreamChunk =
  | { type: "text-delta"; delta: string }
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool-output-available";
      toolCallId: string;
      output: ToolOutput;
    }
  | { type: "text-end" };

/**
 * Interface for pluggable agent adapters
 */
export interface AgentAdapter {
  /**
   * Run the agent with a prompt and conversation history
   */
  run(messages: UIMessage[]): AsyncIterable<AgentStreamChunk>;

  /**
   * Name/Type of the adapter
   */
  readonly type: string;
}

/**
 * Reference implementation for the current Ag-Bash fetch protocol
 */
export class FetchAgentAdapter implements AgentAdapter {
  constructor(private apiEndpoint: string) {}

  get type() {
    return "fetch";
  }

  async *run(messages: UIMessage[]): AsyncIterable<AgentStreamChunk> {
    const response = await fetch(this.apiEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine?.startsWith("data:")) continue;

          const jsonStr = trimmedLine.slice(5).trim();
          if (jsonStr === "[DONE]") continue;

          try {
            yield JSON.parse(jsonStr);
          } catch {
            // Silence parse errors for streaming
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
