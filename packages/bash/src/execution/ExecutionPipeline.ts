/**
 * ExecutionPipeline - Composable stage-based execution engine.
 *
 * Replaces the monolithic Bash.exec() method with an ordered sequence
 * of self-contained stages: normalize -> parse -> transform -> sandbox ->
 * interpret -> persist -> error-handle.
 *
 * Each stage either continues (passing context forward) or short-circuits
 * with a final BashExecResult.
 */

import type { Bash, ExecOptions } from "../Bash.js";
import type { InterpreterState } from "../interpreter/types.js";
import type { ServiceContainer } from "../services/ServiceContainer.js";
import type { BashExecResult } from "../types.js";
import { categorizeError } from "./stages/error-stage.js";
import type { PipelineContext, PipelineStage, StageResult } from "./types.js";

/**
 * Callback applied to every BashExecResult leaving the pipeline (success AND
 * error paths). Mirrors the monolith's Bash.logResult: logs the result and
 * decodes binary (latin1) stdout/stderr to UTF-8 at the output boundary.
 * Returns the (decoded) result.
 */
export type ResultFinalizer = (result: BashExecResult) => BashExecResult;

/**
 * Merge a pending WARN-policy destructive warning (from DestructiveStage) into
 * the interpreter-produced result. Returns a NEW result object (immutability —
 * never mutates the interpreter's result) with the warning observation appended
 * and the warning stderr line PREPENDED so it surfaces before command output.
 * No pending warning → returns the result unchanged.
 */
function mergePendingWarning(context: PipelineContext): BashExecResult {
  const result = context.result;
  if (!result) {
    // Unreachable when called from the result-present branch; satisfies types.
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      env: Object.create(null),
    };
  }
  const pending = context.pendingDestructiveWarning;
  if (!pending) {
    return result;
  }
  return {
    ...result,
    stderr: pending.stderr + result.stderr,
    observations: [...(result.observations ?? []), pending.observation],
  };
}

export class ExecutionPipeline {
  private readonly stages: PipelineStage[] = [];
  private readonly finalize: ResultFinalizer;

  constructor(finalize?: ResultFinalizer) {
    // Default to identity so existing direct usage / tests keep working.
    this.finalize = finalize ?? ((result) => result);
  }

  addStage(stage: PipelineStage): void {
    this.stages.push(stage);
  }

  async run(
    script: string,
    options: ExecOptions | undefined,
    bash: Bash,
    services: ServiceContainer,
    execState: InterpreterState,
    /**
     * The PARENT Bash instance's interpreter state. Used ONLY for error-path
     * env semantics: the monolith builds all 11 error/guard results from
     * `this.state.env` (unchanged on error), NOT the possibly-mutated execState.
     * Defaults to execState when omitted (direct/test usage without a parent).
     */
    parentState?: InterpreterState,
  ): Promise<BashExecResult> {
    const errorEnvState = parentState ?? execState;
    const context: PipelineContext = {
      rawScript: script,
      normalizedScript: script,
      options,
      bash,
      services,
      execState,
      ast: undefined,
      metadata: undefined,
      defenseHandle: undefined,
      result: undefined,
      pendingDestructiveWarning: undefined,
    };

    try {
      for (const stage of this.stages) {
        const stageResult: StageResult = await stage.execute(context);
        if (!stageResult.continue) {
          return this.finalize(stageResult.result);
        }
      }

      // If all stages completed but no result was set, this is a logic error.
      // The interpret stage should always produce a result.
      if (context.result) {
        return this.finalize(mergePendingWarning(context));
      }

      // Fallback: should never reach here with a properly configured pipeline.
      return this.finalize({
        stdout: "",
        stderr: "",
        exitCode: 0,
        env: Object.create(null),
      });
    } catch (error) {
      // Match the monolith's catch (Bash.ts:959-1057): map known interpreter
      // errors into a structured BashExecResult. Critically, env semantics use
      // the PARENT bash.state (which is UNCHANGED on error — persist only runs
      // on exit 0), NOT the possibly-mutated execState. categorizeError returns
      // undefined for unrecognized errors, which we re-throw exactly as the
      // monolith does.
      const categorized = categorizeError(error, errorEnvState, options?.env);
      if (categorized) {
        return this.finalize(categorized);
      }
      throw error;
    } finally {
      // Always clean up the defense-in-depth handle
      context.defenseHandle?.deactivate();
    }
  }
}
