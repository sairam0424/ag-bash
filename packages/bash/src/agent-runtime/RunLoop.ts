/**
 * RunLoop - The autonomous agent loop.
 *
 * Drives multi-turn agent runs by calling an LLM, running tool calls
 * via the sandboxed Bash instance, and repeating until a stop condition is met.
 *
 * Stop conditions:
 * - LLM returns `end_turn` (task complete)
 * - Token budget exhausted
 * - Max turns reached
 * - AbortSignal triggered
 * - Unrecoverable error
 *
 * NOTE: All command invocations go through the sandboxed virtual Bash shell
 * (ag-bash in-memory interpreter), NOT through child_process or system shells.
 */

import type { Bash } from "../Bash.js";
import { BudgetManager } from "./BudgetManager.js";
import type {
  GenerateResponse,
  LLMProvider,
  Message,
  RunLoopConfig,
  RunLoopResult,
  RunLoopStatus,
  ToolCall,
  ToolSchema,
  TurnEvent,
} from "./types.js";

export class RunLoop {
  private readonly bash: Bash;
  private readonly llm: LLMProvider;
  private readonly config: RunLoopConfig;
  private readonly budget: BudgetManager;
  private readonly messages: Message[];
  private readonly tools: ToolSchema[];

  constructor(bash: Bash, config: RunLoopConfig) {
    this.bash = bash;
    this.llm = config.llm;
    this.config = config;
    this.budget = new BudgetManager(config.budget ?? {});
    this.tools = config.tools ?? this.getDefaultTools();
    this.messages = [{ role: "system", content: config.systemPrompt }];
  }

  /**
   * Run the agent loop with the given goal.
   * The loop calls the LLM, runs tool calls, and repeats until done.
   */
  async run(goal: string): Promise<RunLoopResult> {
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

        // Check budget (tokens, turns, wall-clock)
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
      return {
        status,
        turns: stats.turns,
        totalInputTokens: stats.totalInputTokens,
        totalOutputTokens: stats.totalOutputTokens,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const stats = this.budget.getStats();
    return {
      status,
      turns: stats.turns,
      totalInputTokens: stats.totalInputTokens,
      totalOutputTokens: stats.totalOutputTokens,
      finalOutput,
    };
  }

  private async runTurn(response: GenerateResponse): Promise<TurnEvent> {
    const toolCallResults: TurnEvent["toolCalls"] = [];

    // Add assistant message with tool calls
    this.messages.push({
      role: "assistant",
      content: response.content ?? "",
      toolCalls: response.toolCalls,
    });

    // Run each tool call via the sandboxed virtual shell
    for (const toolCall of response.toolCalls ?? []) {
      const start = Date.now();
      const result = await this.invokeToolCall(toolCall);
      const durationMs = Date.now() - start;

      toolCallResults.push({
        name: toolCall.name,
        args: toolCall.args,
        result,
        durationMs,
      });

      // Add tool result message
      this.messages.push({
        role: "tool",
        content: result,
        toolCallId: toolCall.id,
      });
    }

    return {
      turnNumber: this.budget.turns,
      toolCalls: toolCallResults,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cumulativeTokens: this.budget.totalTokens,
    };
  }

  /**
   * Invokes a tool call using the sandboxed ag-bash virtual shell.
   * This does NOT use child_process - it uses the in-memory Bash interpreter.
   */
  private async invokeToolCall(toolCall: ToolCall): Promise<string> {
    const { name, args } = toolCall;

    // The primary tool is "bash" - run commands in the sandboxed shell
    if (name === "bash" || name === "run_command") {
      const command = (args.command ?? args.script ?? "") as string;
      // Uses the sandboxed virtual Bash interpreter (not child_process)
      const result = await this.bash.exec(command);
      return JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }

    // Reject unknown tools — do not construct shell commands from untrusted LLM output
    return JSON.stringify({
      error: `Unknown tool: ${name}. Available tools: ${this.tools.map((t) => t.name).join(", ")}`,
      exitCode: 1,
    });
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
