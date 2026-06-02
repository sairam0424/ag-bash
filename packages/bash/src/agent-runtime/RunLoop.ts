/**
 * RunLoop - The autonomous agent loop.
 *
 * Drives multi-turn agent runs by calling an LLM, running tool calls
 * via the sandboxed Bash instance, and repeating until a stop condition is met.
 *
 * Real-agent-runtime capabilities (A2):
 * - Typed self-correction: `result.observations` (A3) are forwarded in the
 *   tool payload so the LLM sees machine-readable failure codes, not just text.
 * - Self-healing: on a non-zero exit the AgenticHealer is consulted to suggest
 *   (and optionally apply) a correction before the next turn.
 * - Cross-turn memory: salient per-turn facts are persisted to (and loaded
 *   from) the ServiceContainer's AgentMemory store.
 * - Plan-mode enforcement: when mode is "plan", WRITE tools are gated (queued,
 *   not executed); read-only tools still run.
 *
 * Stop conditions:
 * - LLM returns `end_turn` (task complete)
 * - Token / turn / wall-clock budget exhausted
 * - AbortSignal triggered
 * - Unrecoverable error
 *
 * NOTE: All command invocations go through the sandboxed virtual Bash shell
 * (ag-bash in-memory interpreter), NOT through child_process or system shells.
 */

import { AgenticHealer } from "../agentic/agentic-healer.js";
import type { Bash } from "../Bash.js";
import type { MemoryScope } from "../services/AgentMemory.js";
import type { ExecResult, Observation } from "../types.js";
import { BudgetManager } from "./BudgetManager.js";
import type {
  BudgetConfig,
  GenerateResponse,
  LLMProvider,
  Message,
  RunLoopConfig,
  RunLoopResult,
  RunLoopStatus,
  ToolCall,
  ToolCallResult,
  ToolSchema,
  TurnEvent,
} from "./types.js";

/** Built-in write tools that mutate shared shell state (cwd, env, filesystem). */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "run_command"]);

/** Default identity used to scope cross-turn agent memory. */
const DEFAULT_AGENT_TYPE = "run-loop";
/** Default memory scope level. */
const DEFAULT_MEMORY_SCOPE: MemoryScope = "local";

export class RunLoop {
  private readonly bash: Bash;
  private readonly llm: LLMProvider;
  private readonly config: RunLoopConfig;
  private readonly budget: BudgetManager;
  private readonly messages: Message[];
  private readonly tools: ToolSchema[];
  private readonly readOnlyTools: ReadonlySet<string>;
  private readonly healerEnabled: boolean;
  private readonly healerAutoFix: boolean;
  private healer: AgenticHealer | undefined;
  private gatedToolCalls = 0;
  private healingAttempts = 0;

  constructor(bash: Bash, config: RunLoopConfig) {
    this.bash = bash;
    this.llm = config.llm;
    this.config = config;
    this.budget = new BudgetManager(
      config.budget ?? (Object.create(null) as BudgetConfig),
    );
    this.tools = config.tools ?? this.getDefaultTools();
    this.readOnlyTools = new Set(config.readOnlyTools ?? []);
    this.healerEnabled = config.healer?.enabled !== false;
    this.healerAutoFix = config.healer?.autoFix === true;
    this.messages = [{ role: "system", content: config.systemPrompt }];

    // Honor the requested initial mode (plan vs execute). When omitted the
    // loop inherits whatever mode the Bash instance is already in.
    if (config.mode) {
      this.bash.setMode(config.mode);
    }
  }

  /**
   * Run the agent loop with the given goal.
   * The loop calls the LLM, runs tool calls, and repeats until done.
   */
  async run(goal: string): Promise<RunLoopResult> {
    // Hydrate + load cross-turn memory BEFORE the first LLM call so prior
    // salient facts inform the run from turn one.
    await this.loadMemoryContext();

    this.messages.push({ role: "user", content: goal });

    let status: RunLoopStatus = "completed";
    let finalOutput: string | undefined;

    try {
      while (true) {
        // Check abort signal
        if (this.config.signal?.aborted) {
          status = "aborted";
          break;
        }

        // Check budget (tokens, turns, wall-clock) — prevents runaway recursion.
        if (this.budget.isExhausted()) {
          status = "budget_exhausted";
          break;
        }

        // Call LLM
        const response = await this.llm.generate({
          messages: this.messages,
          tools: this.tools,
        });

        // Record token usage
        this.budget.recordUsage(
          response.usage.inputTokens,
          response.usage.outputTokens,
        );

        // Process response
        if (
          response.stopReason === "end_turn" ||
          (!response.toolCalls?.length && response.content)
        ) {
          finalOutput = response.content;
          if (response.content) {
            this.messages.push({
              role: "assistant",
              content: response.content,
            });
          }
          break;
        }

        // Run tool calls
        if (response.toolCalls?.length) {
          const turnEvent = await this.runTurn(response);

          if (this.config.onTurn) {
            this.config.onTurn(turnEvent);
          }
        } else {
          // No content and no tool calls - end
          break;
        }
      }
    } catch (error) {
      status = "error";
      const stats = this.budget.getStats();
      // Persist what we learned even on the error path.
      await this.persistMemory(`error:${stats.turns}`, sanitize(error));
      return {
        status,
        turns: stats.turns,
        totalInputTokens: stats.totalInputTokens,
        totalOutputTokens: stats.totalOutputTokens,
        error: sanitize(error),
        gatedToolCalls: this.gatedToolCalls,
        healingAttempts: this.healingAttempts,
      };
    }

    const stats = this.budget.getStats();
    if (finalOutput) {
      await this.persistMemory("final-output", finalOutput);
    }
    return {
      status,
      turns: stats.turns,
      totalInputTokens: stats.totalInputTokens,
      totalOutputTokens: stats.totalOutputTokens,
      finalOutput,
      gatedToolCalls: this.gatedToolCalls,
      healingAttempts: this.healingAttempts,
    };
  }

  private async runTurn(response: GenerateResponse): Promise<TurnEvent> {
    // Add assistant message with tool calls
    this.messages.push({
      role: "assistant",
      content: response.content ?? "",
      toolCalls: response.toolCalls,
    });

    const toolCalls = response.toolCalls ?? [];

    // Execute tool calls - parallel when safe, sequential otherwise.
    // Tools that modify shared state (bash/run_command) mutate cwd, env vars,
    // and filesystem. Only parallelize read-only tools that don't share state.
    const toolCallResults = await this.executeToolCalls(toolCalls);

    // Append tool result messages in order (preserves message ordering
    // regardless of execution strategy)
    for (const entry of toolCallResults) {
      this.messages.push({
        role: "tool",
        content: entry.result,
        toolCallId: entry.toolCallId,
      });
    }

    // Persist a salient fact for this turn so future turns (and future runs)
    // can recall what happened. Kept compact to avoid memory bloat.
    await this.persistTurnMemory(toolCallResults);

    return {
      turnNumber: this.budget.turns,
      toolCalls: toolCallResults.map((entry) => ({
        name: entry.name,
        args: entry.args,
        result: entry.result,
        durationMs: entry.durationMs,
        gated: entry.gated,
        healingSuggestion: entry.healingSuggestion,
      })),
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cumulativeTokens: this.budget.totalTokens,
    };
  }

  /**
   * Determines whether a tool call is read-only (safe for parallel execution
   * AND permitted in plan mode). A tool is read-only when it is in the
   * configured `readOnlyTools` allowlist OR it is not a known write tool.
   */
  private isReadOnlyTool(toolCall: ToolCall): boolean {
    if (this.readOnlyTools.has(toolCall.name)) return true;
    // bash and run_command tools modify shared shell state (env, cwd, files)
    // and must always be executed sequentially to avoid race conditions.
    return !WRITE_TOOL_NAMES.has(toolCall.name);
  }

  /**
   * Whether a tool call must be GATED (blocked) under the current mode.
   * In "plan" mode, write tools are gated; read-only tools always run.
   */
  private isGated(toolCall: ToolCall): boolean {
    return this.bash.getMode() === "plan" && !this.isReadOnlyTool(toolCall);
  }

  /**
   * Execute tool calls with optimal parallelism:
   * - Single tool call: await directly (no Promise.all overhead)
   * - Multiple read-only tools: parallel via Promise.all
   * - Any write tool present: sequential execution (preserves state ordering)
   */
  private async executeToolCalls(
    toolCalls: ToolCall[],
  ): Promise<ToolCallResult[]> {
    // Fast path: single tool call, no overhead
    if (toolCalls.length === 1) {
      return [await this.runOne(toolCalls[0])];
    }

    // Check if all tool calls are read-only (safe for parallel execution).
    // Gated (plan-mode-blocked) calls are pure/no-op, so they are also safe to
    // resolve in parallel.
    const allParallelSafe = toolCalls.every(
      (tc) => this.isReadOnlyTool(tc) || this.isGated(tc),
    );

    if (allParallelSafe) {
      // Parallel execution - all tools are read-only / gated, no shared state.
      return await Promise.all(toolCalls.map((tc) => this.runOne(tc)));
    }

    // Sequential execution - write tools present, must preserve ordering
    const results: ToolCallResult[] = [];
    for (const toolCall of toolCalls) {
      results.push(await this.runOne(toolCall));
    }
    return results;
  }

  /** Times and invokes a single tool call, producing a ToolCallResult. */
  private async runOne(toolCall: ToolCall): Promise<ToolCallResult> {
    const start = Date.now();
    const invoked = await this.invokeToolCall(toolCall);
    const durationMs = Date.now() - start;
    return {
      name: toolCall.name,
      args: toolCall.args,
      result: invoked.result,
      durationMs,
      toolCallId: toolCall.id,
      observations: invoked.observations,
      gated: invoked.gated,
      healingSuggestion: invoked.healingSuggestion,
    };
  }

  /**
   * Invokes a tool call using the sandboxed ag-bash virtual shell.
   * This does NOT use child_process - it uses the in-memory Bash interpreter.
   *
   * Plan-mode: write tools are gated here (queued, never executed). The agent
   * receives a structured `gated: true` payload so it can plan accordingly.
   */
  private async invokeToolCall(toolCall: ToolCall): Promise<{
    result: string;
    observations?: Observation[];
    gated?: boolean;
    healingSuggestion?: string;
  }> {
    const { name, args } = toolCall;

    // The primary tools are "bash" / "run_command" - run in the sandboxed shell.
    if (name === "bash" || name === "run_command") {
      const command = (args.command ?? args.script ?? "") as string;

      // Plan-mode gate: do NOT execute write tools; queue them instead.
      if (this.isGated(toolCall)) {
        this.gatedToolCalls += 1;
        return {
          gated: true,
          result: JSON.stringify({
            gated: true,
            mode: "plan",
            command,
            message:
              "Write tool blocked in plan mode. The command was queued, not executed. Switch to execute mode to run it.",
          }),
        };
      }

      // Uses the sandboxed virtual Bash interpreter (not child_process)
      const result = await this.bash.exec(command);

      // On failure, consult the healer for active recovery / suggestion BEFORE
      // returning the payload to the LLM for the next turn.
      let effective: ExecResult = result;
      let healingSuggestion: string | undefined;
      if (result.exitCode !== 0 && this.healerEnabled) {
        const healed = await this.attemptHealing(command, result);
        effective = healed.result;
        healingSuggestion = healed.suggestion;
      }

      // FORWARD typed observations (A3) so the LLM can self-correct on stable
      // machine codes rather than parsing English stderr.
      const payload: Record<string, unknown> = Object.create(null);
      payload.stdout = effective.stdout;
      payload.stderr = effective.stderr;
      payload.exitCode = effective.exitCode;
      if (effective.observations?.length) {
        payload.observations = effective.observations;
      }
      if (healingSuggestion) {
        payload.healingSuggestion = healingSuggestion;
      }

      return {
        result: JSON.stringify(payload),
        observations: effective.observations,
        healingSuggestion,
      };
    }

    // Reject unknown tools — do not construct shell commands from untrusted LLM output
    return {
      result: JSON.stringify({
        error: `Unknown tool: ${name}. Available tools: ${this.tools.map((t) => t.name).join(", ")}`,
        exitCode: 1,
      }),
    };
  }

  /**
   * Consults the AgenticHealer on a failed command. When autoFix is enabled the
   * healer may actively re-execute a corrected command on the shell (respecting
   * its own retry cap); otherwise it only produces a suggestion string. The
   * healer's own re-executions are bounded by its maxRetries and DO NOT bypass
   * the loop's budget checks (the loop re-checks budget on the next turn).
   */
  private async attemptHealing(
    command: string,
    result: ExecResult,
  ): Promise<{ result: ExecResult; suggestion?: string }> {
    this.healingAttempts += 1;
    const healer = this.getHealer();

    // Active recovery: re-execute a corrected command on the sandboxed shell.
    if (this.healerAutoFix) {
      const healed = await healer.heal(command, result, (cmd) =>
        this.bash.exec(cmd),
      );
      if (healed && healed.exitCode === 0) {
        return {
          result: healed,
          suggestion: `Auto-healed: re-ran a corrected command successfully.`,
        };
      }
    }

    // Suggestion-only path: surface a correction to the agent without mutating
    // shell state behind its back.
    const correction = healer.suggestCorrection(command, result);
    if (correction && correction !== command) {
      return { result, suggestion: `Did you mean: ${correction}` };
    }
    return { result };
  }

  /** Lazily constructs the healer with config derived from RunLoopConfig. */
  private getHealer(): AgenticHealer {
    if (this.healer) return this.healer;
    this.healer = new AgenticHealer(undefined, {
      enableHeuristics: true,
      autoRetry: {
        enabled: this.healerAutoFix,
        maxRetries: this.config.healer?.maxRetries ?? 2,
      },
    });
    return this.healer;
  }

  // ─── Cross-turn memory ─────────────────────────────────────────────────────

  /** Whether memory persistence is active for this run. */
  private get memoryEnabled(): boolean {
    return (
      this.config.memory !== undefined && this.config.memory.persist !== false
    );
  }

  private get agentType(): string {
    return this.config.memory?.agentType ?? DEFAULT_AGENT_TYPE;
  }

  private get memoryScope(): MemoryScope {
    return this.config.memory?.scope ?? DEFAULT_MEMORY_SCOPE;
  }

  /**
   * Hydrates the AgentMemory store and injects prior salient facts into the
   * system context so the agent recalls past decisions across turns AND runs.
   */
  private async loadMemoryContext(): Promise<void> {
    if (this.config.memory === undefined) return;
    await this.bash.services.ensureAgentMemoryHydrated();
    const entries = this.bash.services.agentMemory.list(
      this.agentType,
      this.memoryScope,
    );
    if (entries.length === 0) return;
    const recalled = entries.map((e) => `- ${e.key}: ${e.value}`).join("\n");
    this.messages.push({
      role: "system",
      content: `Recalled memory from prior turns:\n${recalled}`,
    });
  }

  /** Persists one salient key/value fact (no-op when memory is disabled). */
  private async persistMemory(key: string, value: string): Promise<void> {
    if (!this.memoryEnabled) return;
    this.bash.services.agentMemory.write(
      this.agentType,
      this.memoryScope,
      key,
      truncate(value),
    );
  }

  /** Records a compact summary of a turn's tool outcomes. */
  private async persistTurnMemory(results: ToolCallResult[]): Promise<void> {
    if (!this.memoryEnabled || results.length === 0) return;
    const summary = results
      .map((r) => {
        const parsed = tryParse(r.result);
        const exit =
          parsed && typeof parsed.exitCode === "number" ? parsed.exitCode : "?";
        const flags = [
          r.gated ? "gated" : null,
          r.healingSuggestion ? "healed" : null,
        ]
          .filter(Boolean)
          .join(",");
        return `${r.name}(exit=${exit}${flags ? `,${flags}` : ""})`;
      })
      .join("; ");
    await this.persistMemory(`turn-${this.budget.turns}`, summary);
  }

  private getDefaultTools(): ToolSchema[] {
    const props = Object.create(null) as Record<string, unknown>;
    props.command = {
      type: "string",
      description: "The bash command to run",
    };
    const schema = Object.create(null) as Record<string, unknown>;
    schema.type = "object";
    schema.properties = props;
    schema.required = ["command"];
    return [
      {
        name: "bash",
        description: "Run a bash command in the sandboxed shell environment",
        inputSchema: schema,
      },
    ];
  }
}

/** Safely truncates a memory value to keep the store compact. */
function truncate(value: string, max = 512): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Sanitizes an unknown error into a safe string (no raw stack to callers). */
function sanitize(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Best-effort JSON parse; returns null on any failure. */
function tryParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
