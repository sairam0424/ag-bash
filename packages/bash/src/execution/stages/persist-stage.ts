/**
 * PersistStage - State persistence after execution.
 *
 * If persistState is enabled and the execution succeeded (exit code 0),
 * commits the execution state (cwd, env, functions, options) back to the
 * parent Bash instance.
 */

import type { InterpreterState } from "../../interpreter/types.js";
import type { PipelineContext, PipelineStage, StageResult } from "../types.js";

/**
 * Callback interface for persisting state back to the Bash instance.
 * Avoids direct coupling to Bash internals.
 */
export type PersistCallback = (
  execState: InterpreterState,
  exitCode: number,
) => void;

export class PersistStage implements PipelineStage {
  readonly name = "persist";

  private readonly defaultPersistState: boolean;
  private readonly persistCallback: PersistCallback;

  constructor(defaultPersistState: boolean, persistCallback: PersistCallback) {
    this.defaultPersistState = defaultPersistState;
    this.persistCallback = persistCallback;
  }

  async execute(context: PipelineContext): Promise<StageResult> {
    const { options, execState, result } = context;

    if (result === undefined) {
      return { continue: true, context };
    }

    const shouldPersist = options?.persistState ?? this.defaultPersistState;
    if (shouldPersist && result.exitCode === 0) {
      this.persistCallback(execState, result.exitCode);
    }

    return { continue: true, context };
  }
}
