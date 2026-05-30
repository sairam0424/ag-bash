/**
 * ExecutionPipeline Types
 *
 * Defines the composable pipeline architecture for Bash.exec().
 * Each stage receives a PipelineContext and either continues to the
 * next stage or short-circuits with a final ExecResult.
 */

import type { ScriptNode } from "../ast/types.js";
import type { Bash, ExecOptions } from "../Bash.js";
import type { InterpreterState } from "../interpreter/types.js";
import type { DefenseInDepthHandle } from "../security/types.js";
import type { ServiceContainer } from "../services/ServiceContainer.js";
import type { BashExecResult, Observation } from "../types.js";

/**
 * A non-blocking destructive-command warning produced by the DestructiveStage
 * under the WARN policy. The script STILL executes; this is merged into the
 * final result (observation + stderr line) by the pipeline runner so the
 * warning rides on the interpreter-produced result.
 */
export interface PendingDestructiveWarning {
  /** Typed observation to append to result.observations. */
  observation: Observation;
  /** Human-readable stderr warning line (already newline-terminated). */
  stderr: string;
}

/**
 * Mutable context threaded through all pipeline stages.
 * Each stage reads/writes fields relevant to its responsibility.
 */
export interface PipelineContext {
  /** The raw script string passed to exec() */
  rawScript: string;
  /** Normalized script (after whitespace/heredoc processing) */
  normalizedScript: string;
  /** Exec options from the caller */
  options: ExecOptions | undefined;
  /** Reference to the parent Bash instance */
  bash: Bash;
  /** Service container for caches, buses, etc. */
  services: ServiceContainer;
  /** Interpreter state snapshot for this execution */
  execState: InterpreterState;
  /** Parsed AST (populated by parse stage) */
  ast: ScriptNode | undefined;
  /** Transform metadata from plugins (populated by transform stage) */
  metadata: Record<string, unknown> | undefined;
  /** Defense-in-depth handle (populated by sandbox stage) */
  defenseHandle: DefenseInDepthHandle | undefined;
  /** Final execution result (populated by interpret or error stage) */
  result: BashExecResult | undefined;
  /**
   * Pending non-blocking destructive warning (populated by DestructiveStage
   * under WARN policy). Merged into the final result by the pipeline runner
   * AFTER interpret produces it, so the script still executes with the warning
   * attached. Undefined when no destructive command was detected, or under the
   * BLOCK / ALLOW policies (BLOCK short-circuits; ALLOW emits nothing).
   */
  pendingDestructiveWarning: PendingDestructiveWarning | undefined;
}

/**
 * Discriminated union result type for pipeline stages.
 * - `continue: true` means proceed to the next stage.
 * - `continue: false` means short-circuit; `result` is the final output.
 */
export type StageResult =
  | { continue: true; context: PipelineContext }
  | { continue: false; result: BashExecResult };

/**
 * A single composable stage in the execution pipeline.
 * Stages execute sequentially; any stage may short-circuit.
 */
export interface PipelineStage {
  /** Human-readable name for debugging/tracing */
  readonly name: string;
  /** Execute this stage's logic against the pipeline context */
  execute(context: PipelineContext): Promise<StageResult>;
}
