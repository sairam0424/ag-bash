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
import type { BashExecResult } from "../types.js";

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
