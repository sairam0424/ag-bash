/**
 * Tests for the Agent RunLoop and BudgetManager.
 *
 * Uses a mock LLMProvider to simulate multi-turn agent interactions
 * without requiring any external API calls.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { BudgetManager } from "./BudgetManager.js";
import { RunLoop } from "./RunLoop.js";
import type { GenerateRequest, GenerateResponse, LLMProvider } from "./types.js";

/**
 * Creates a mock LLM that returns scripted responses in sequence.
 * After all scripted responses are exhausted, returns a default end_turn.
 */
function createMockLLM(responses: GenerateResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    async generate(_request: GenerateRequest): Promise<GenerateResponse> {
      const response = responses[callIndex];
      if (!response) {
        return {
          content: "Done",
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      callIndex++;
      return response;
    },
  };
}

describe("BudgetManager", () => {
  it("tracks token usage", () => {
    const budget = new BudgetManager({});
    budget.recordUsage(100, 50);
    budget.recordUsage(200, 75);

    const stats = budget.getStats();
    expect(stats.totalInputTokens).toBe(300);
    expect(stats.totalOutputTokens).toBe(125);
    expect(stats.totalTokens).toBe(425);
    expect(stats.turns).toBe(2);
  });

  it("detects token budget exhaustion", () => {
    const budget = new BudgetManager({ maxTokens: 500 });

    budget.recordUsage(200, 100);
    expect(budget.isExhausted()).toBe(false);

    budget.recordUsage(150, 100);
    expect(budget.isExhausted()).toBe(true);
  });

  it("detects turn budget exhaustion", () => {
    const budget = new BudgetManager({ maxTurns: 3 });

    budget.recordUsage(10, 5);
    expect(budget.isExhausted()).toBe(false);

    budget.recordUsage(10, 5);
    expect(budget.isExhausted()).toBe(false);

    budget.recordUsage(10, 5);
    expect(budget.isExhausted()).toBe(true);
  });

  it("tracks elapsed time", () => {
    const budget = new BudgetManager({});
    // elapsed should be >= 0
    expect(budget.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("reports not exhausted when no limits are set", () => {
    const budget = new BudgetManager({});
    budget.recordUsage(999999, 999999);
    expect(budget.isExhausted()).toBe(false);
  });

  it("detects wall clock budget exhaustion", () => {
    // Use a very small maxWallClockMs to ensure it triggers
    const budget = new BudgetManager({ maxWallClockMs: 0 });
    expect(budget.isExhausted()).toBe(true);
  });
});

describe("RunLoop", () => {
  it("completes when LLM returns end_turn", async () => {
    const bash = new Bash({ persistState: true });
    const llm = createMockLLM([
      {
        content: "All done!",
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 20 },
      },
    ]);
    const loop = new RunLoop(bash, { llm, systemPrompt: "You are helpful." });
    const result = await loop.run("Do nothing");

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toBe("All done!");
    expect(result.turns).toBe(1);
    expect(result.totalInputTokens).toBe(50);
    expect(result.totalOutputTokens).toBe(20);
  });

  it("runs tool calls and feeds results back", async () => {
    const bash = new Bash({ persistState: true });
    const llm = createMockLLM([
      {
        toolCalls: [
          { id: "tc1", name: "bash", args: { command: "echo hello" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      {
        content: "I ran the command.",
        stopReason: "end_turn",
        usage: { inputTokens: 150, outputTokens: 30 },
      },
    ]);
    const loop = new RunLoop(bash, { llm, systemPrompt: "Run commands." });
    const result = await loop.run("Run echo hello");

    expect(result.status).toBe("completed");
    expect(result.turns).toBe(2);
    expect(result.totalInputTokens).toBe(250);
    expect(result.totalOutputTokens).toBe(80);
    expect(result.finalOutput).toBe("I ran the command.");
  });

  it("stops when budget is exhausted", async () => {
    const bash = new Bash({ persistState: true });
    const llm = createMockLLM([
      {
        toolCalls: [
          { id: "tc1", name: "bash", args: { command: "echo 1" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 600, outputTokens: 400 },
      },
      {
        toolCalls: [
          { id: "tc2", name: "bash", args: { command: "echo 2" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 600, outputTokens: 400 },
      },
    ]);
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "Keep going.",
      budget: { maxTokens: 1500 },
    });
    const result = await loop.run("Keep running");

    expect(result.status).toBe("budget_exhausted");
  });

  it("stops when max turns reached", async () => {
    const bash = new Bash({ persistState: true });
    const llm = createMockLLM([
      {
        toolCalls: [
          { id: "tc1", name: "bash", args: { command: "echo 1" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        toolCalls: [
          { id: "tc2", name: "bash", args: { command: "echo 2" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        toolCalls: [
          { id: "tc3", name: "bash", args: { command: "echo 3" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "Go.",
      budget: { maxTurns: 2 },
    });
    const result = await loop.run("Loop forever");

    expect(result.status).toBe("budget_exhausted");
    expect(result.turns).toBe(2);
  });

  it("respects abort signal", async () => {
    const bash = new Bash({ persistState: true });
    const controller = new AbortController();
    controller.abort(); // Pre-abort
    const llm = createMockLLM([]);
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "X",
      signal: controller.signal,
    });
    const result = await loop.run("Anything");

    expect(result.status).toBe("aborted");
  });

  it("calls onTurn callback", async () => {
    const bash = new Bash({ persistState: true });
    const turns: TurnEvent[] = [];
    const llm = createMockLLM([
      {
        toolCalls: [
          { id: "tc1", name: "bash", args: { command: "echo hi" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 20 },
      },
      {
        content: "Done",
        stopReason: "end_turn",
        usage: { inputTokens: 70, outputTokens: 10 },
      },
    ]);
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "Go.",
      onTurn: (e) => turns.push(e),
    });
    await loop.run("Say hi");

    expect(turns.length).toBe(1);
    expect(turns[0].toolCalls[0].name).toBe("bash");
    expect(turns[0].toolCalls[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(turns[0].turnNumber).toBe(1);
    expect(turns[0].cumulativeTokens).toBe(70);
  });

  it("handles LLM errors gracefully", async () => {
    const bash = new Bash({ persistState: true });
    const llm: LLMProvider = {
      async generate(_request: GenerateRequest): Promise<GenerateResponse> {
        throw new Error("API rate limited");
      },
    };
    const loop = new RunLoop(bash, { llm, systemPrompt: "Go." });
    const result = await loop.run("Do something");

    expect(result.status).toBe("error");
    expect(result.error).toBe("API rate limited");
  });

  it("handles run_command tool name", async () => {
    const bash = new Bash({ persistState: true });
    const llm = createMockLLM([
      {
        toolCalls: [
          { id: "tc1", name: "run_command", args: { command: "echo works" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 20 },
      },
      {
        content: "Ran it.",
        stopReason: "end_turn",
        usage: { inputTokens: 70, outputTokens: 10 },
      },
    ]);
    const loop = new RunLoop(bash, { llm, systemPrompt: "Go." });
    const result = await loop.run("Run echo");

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toBe("Ran it.");
  });

  it("uses custom tools when provided", async () => {
    const bash = new Bash({ persistState: true });
    const customTools = [
      {
        name: "my_tool",
        description: "A custom tool",
        inputSchema: {
          type: "object",
          properties: { arg: { type: "string" } },
          required: ["arg"],
        },
      },
    ];
    const llm = createMockLLM([
      {
        content: "Using custom tools.",
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 15 },
      },
    ]);
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "Use tools.",
      tools: customTools,
    });
    const result = await loop.run("Go");

    expect(result.status).toBe("completed");
  });

  it("handles multiple tool calls in a single turn", async () => {
    const bash = new Bash({ persistState: true });
    const turns: TurnEvent[] = [];
    const llm = createMockLLM([
      {
        toolCalls: [
          { id: "tc1", name: "bash", args: { command: "echo first" } },
          { id: "tc2", name: "bash", args: { command: "echo second" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 80, outputTokens: 40 },
      },
      {
        content: "Both done.",
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    ]);
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "Go.",
      onTurn: (e) => turns.push(e),
    });
    const result = await loop.run("Run two commands");

    expect(result.status).toBe("completed");
    expect(turns[0].toolCalls.length).toBe(2);
    expect(turns[0].toolCalls[0].name).toBe("bash");
    expect(turns[0].toolCalls[1].name).toBe("bash");
  });
});

// Re-export TurnEvent type for the test's type annotation
import type { TurnEvent } from "./types.js";
