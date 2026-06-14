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
import type {
  GenerateRequest,
  GenerateResponse,
  LLMProvider,
} from "./types.js";

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
        toolCalls: [{ id: "tc1", name: "bash", args: { command: "echo 1" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 600, outputTokens: 400 },
      },
      {
        toolCalls: [{ id: "tc2", name: "bash", args: { command: "echo 2" } }],
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
        toolCalls: [{ id: "tc1", name: "bash", args: { command: "echo 1" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        toolCalls: [{ id: "tc2", name: "bash", args: { command: "echo 2" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        toolCalls: [{ id: "tc3", name: "bash", args: { command: "echo 3" } }],
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
        toolCalls: [{ id: "tc1", name: "bash", args: { command: "echo hi" } }],
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

/**
 * A2 - Real agent runtime capabilities.
 *
 * An LLM that captures every request it receives so tests can assert exactly
 * what was fed back to the model (tool payloads, observations, etc.).
 */
function createCapturingLLM(responses: GenerateResponse[]): {
  llm: LLMProvider;
  requests: GenerateRequest[];
} {
  let callIndex = 0;
  const requests: GenerateRequest[] = [];
  return {
    requests,
    llm: {
      async generate(request: GenerateRequest): Promise<GenerateResponse> {
        // Snapshot the messages so later mutations don't affect the capture.
        requests.push({
          messages: request.messages.map((m) => ({ ...m })),
          tools: request.tools,
        });
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
    },
  };
}

describe("RunLoop A2: observation forwarding", () => {
  it("forwards typed observations into the tool result payload", async () => {
    const bash = new Bash({ persistState: true });
    const { llm } = createCapturingLLM([
      {
        toolCalls: [
          {
            id: "tc1",
            name: "bash",
            args: { command: "thiscommanddoesnotexist_xyz" },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 20 },
      },
      {
        content: "Saw the failure.",
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 10 },
      },
    ]);
    const turns: TurnEvent[] = [];
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "Go.",
      // Healer enabled by default; observations must still survive.
      onTurn: (e) => turns.push(e),
    });
    const result = await loop.run("Run a bogus command");

    expect(result.status).toBe("completed");
    // The tool result fed to the LLM must contain the typed observation with
    // its stable machine code, not just English stderr.
    const toolResult = turns[0].toolCalls[0].result;
    const parsed = JSON.parse(toolResult);
    expect(parsed.exitCode).toBe(127);
    expect(Array.isArray(parsed.observations)).toBe(true);
    expect(parsed.observations[0].code).toBe("CMD_NOT_FOUND");
    expect(parsed.observations[0].confidence).toBe(1);
  });

  it("omits observations key on a successful command", async () => {
    const bash = new Bash({ persistState: true });
    const turns: TurnEvent[] = [];
    const llm = createMockLLM([
      {
        toolCalls: [{ id: "tc1", name: "bash", args: { command: "echo ok" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 20 },
      },
      {
        content: "Done.",
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 10 },
      },
    ]);
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "Go.",
      onTurn: (e) => turns.push(e),
    });
    await loop.run("echo");

    const parsed = JSON.parse(turns[0].toolCalls[0].result);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.observations).toBeUndefined();
  });
});

describe("RunLoop A2: self-healing", () => {
  it("surfaces a healing suggestion in the payload on a typo failure", async () => {
    const bash = new Bash({ persistState: true });
    const turns: TurnEvent[] = [];
    const llm = createMockLLM([
      {
        // 'ecko' is one edit away from 'echo' -> healer suggests a correction.
        toolCalls: [
          { id: "tc1", name: "bash", args: { command: "ecko hello" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 20 },
      },
      {
        content: "Got the hint.",
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 10 },
      },
    ]);
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "Go.",
      onTurn: (e) => turns.push(e),
    });
    const result = await loop.run("Run ecko");

    expect(result.healingAttempts).toBe(1);
    const parsed = JSON.parse(turns[0].toolCalls[0].result);
    expect(parsed.healingSuggestion).toContain("echo hello");
    expect(turns[0].toolCalls[0].healingSuggestion).toContain("echo hello");
  });

  it("does not consult the healer when disabled", async () => {
    const bash = new Bash({ persistState: true });
    const turns: TurnEvent[] = [];
    const llm = createMockLLM([
      {
        toolCalls: [
          { id: "tc1", name: "bash", args: { command: "ecko hello" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 20 },
      },
      {
        content: "Done.",
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 10 },
      },
    ]);
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "Go.",
      healer: { enabled: false },
      onTurn: (e) => turns.push(e),
    });
    const result = await loop.run("Run ecko");

    expect(result.healingAttempts).toBe(0);
    const parsed = JSON.parse(turns[0].toolCalls[0].result);
    expect(parsed.healingSuggestion).toBeUndefined();
  });

  it("auto-fixes a typo by re-executing the corrected command", async () => {
    const bash = new Bash({ persistState: true });
    const turns: TurnEvent[] = [];
    const llm = createMockLLM([
      {
        toolCalls: [
          { id: "tc1", name: "bash", args: { command: "ecko healed" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 20 },
      },
      {
        content: "Done.",
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 10 },
      },
    ]);
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "Go.",
      healer: { enabled: true, autoFix: true },
      onTurn: (e) => turns.push(e),
    });
    const result = await loop.run("Run ecko");

    expect(result.healingAttempts).toBe(1);
    const parsed = JSON.parse(turns[0].toolCalls[0].result);
    // After auto-heal the corrected command (echo healed) succeeded.
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toContain("healed");
    expect(parsed.healingSuggestion).toContain("Auto-healed");
  });
});

describe("RunLoop A2: cross-turn memory", () => {
  it("persists turn facts and recalls them on a later run", async () => {
    const bash = new Bash({ persistState: true });

    // Run 1: execute a command; the loop should persist a turn summary.
    const llm1 = createMockLLM([
      {
        toolCalls: [
          { id: "tc1", name: "bash", args: { command: "echo first" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 20 },
      },
      {
        content: "First run done.",
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 10 },
      },
    ]);
    const loop1 = new RunLoop(bash, {
      llm: llm1,
      systemPrompt: "Go.",
      memory: { agentType: "tester", scope: "local" },
    });
    await loop1.run("Run first");

    // Memory must contain the persisted turn summary + final output.
    const stored = bash.services.agentMemory.list("tester", "local");
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.some((e) => e.key === "final-output")).toBe(true);
    expect(stored.some((e) => e.key.startsWith("turn-"))).toBe(true);

    // Run 2 (same Bash, same memory store): the loop must inject the recalled
    // memory into the system context fed to the LLM.
    const { llm: llm2, requests } = createCapturingLLM([
      {
        content: "Second run done.",
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 10 },
      },
    ]);
    const loop2 = new RunLoop(bash, {
      llm: llm2,
      systemPrompt: "Go again.",
      memory: { agentType: "tester", scope: "local" },
    });
    await loop2.run("Run second");

    const firstRequest = requests[0];
    const recalled = firstRequest.messages.find(
      (m) => m.role === "system" && m.content.includes("Recalled memory"),
    );
    expect(recalled).toBeDefined();
    expect(recalled?.content).toContain("final-output");
  });

  it("does not touch memory when no memory config is supplied", async () => {
    const bash = new Bash({ persistState: true });
    const llm = createMockLLM([
      {
        toolCalls: [{ id: "tc1", name: "bash", args: { command: "echo x" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 20 },
      },
      {
        content: "Done.",
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 10 },
      },
    ]);
    const loop = new RunLoop(bash, { llm, systemPrompt: "Go." });
    await loop.run("Run x");

    expect(bash.services.agentMemory.list("run-loop").length).toBe(0);
  });
});

describe("RunLoop A2: plan-mode enforcement", () => {
  it("gates a write tool in plan mode instead of executing it", async () => {
    const bash = new Bash({ persistState: true });
    const turns: TurnEvent[] = [];
    const llm = createMockLLM([
      {
        toolCalls: [
          {
            id: "tc1",
            name: "bash",
            args: { command: "echo SHOULD_NOT_RUN > /tmp/plan-guard.txt" },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 20 },
      },
      {
        content: "Planned.",
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 10 },
      },
    ]);
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "Plan only.",
      mode: "plan",
      onTurn: (e) => turns.push(e),
    });
    const result = await loop.run("Write a file");

    expect(result.gatedToolCalls).toBe(1);
    expect(turns[0].toolCalls[0].gated).toBe(true);
    const parsed = JSON.parse(turns[0].toolCalls[0].result);
    expect(parsed.gated).toBe(true);
    expect(parsed.mode).toBe("plan");

    // The side effect must NOT have happened — the file does not exist.
    const check = await bash.exec("cat /tmp/plan-guard.txt");
    expect(check.exitCode).not.toBe(0);
  });

  it("allows a read-only tool in plan mode via the allowlist", async () => {
    const bash = new Bash({ persistState: true });
    const turns: TurnEvent[] = [];
    const llm = createMockLLM([
      {
        toolCalls: [
          { id: "tc1", name: "read_file", args: { command: "echo hi" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 20 },
      },
      {
        content: "Read it.",
        stopReason: "end_turn",
        usage: { inputTokens: 30, outputTokens: 10 },
      },
    ]);
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "Plan.",
      mode: "plan",
      // read_file is not a known write tool, so it is read-only and permitted.
      readOnlyTools: ["read_file"],
      onTurn: (e) => turns.push(e),
    });
    const result = await loop.run("Read");

    // read_file isn't a recognized executable tool, but it is NOT gated — it is
    // routed to the unknown-tool branch (executed, not blocked).
    expect(result.gatedToolCalls).toBe(0);
    expect(turns[0].toolCalls[0].gated).toBeUndefined();
  });
});

describe("RunLoop A2: budget stops the loop", () => {
  it("halts a runaway tool-call loop once max turns is reached", async () => {
    const bash = new Bash({ persistState: true });
    let calls = 0;
    // An LLM that NEVER ends the turn — it always asks for another tool call.
    const llm: LLMProvider = {
      async generate(): Promise<GenerateResponse> {
        calls += 1;
        return {
          toolCalls: [
            { id: `tc${calls}`, name: "bash", args: { command: "echo loop" } },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };
    const loop = new RunLoop(bash, {
      llm,
      systemPrompt: "Loop forever.",
      budget: { maxTurns: 3 },
    });
    const result = await loop.run("Never stop");

    expect(result.status).toBe("budget_exhausted");
    expect(result.turns).toBe(3);
    // The loop must have stopped calling the LLM — not run unbounded.
    expect(calls).toBe(3);
  });
});

// Re-export TurnEvent type for the test's type annotation
import type { TurnEvent } from "./types.js";
