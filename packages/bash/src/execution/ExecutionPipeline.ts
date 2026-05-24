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
import type { PipelineContext, PipelineStage, StageResult } from "./types.js";

export class ExecutionPipeline {
  private readonly stages: PipelineStage[] = [];

  addStage(stage: PipelineStage): void {
    this.stages.push(stage);
  }

  async run(
    script: string,
    options: ExecOptions | undefined,
    bash: Bash,
    services: ServiceContainer,
    execState: InterpreterState,
  ): Promise<BashExecResult> {
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
    };

    try {
      for (const stage of this.stages) {
        const stageResult: StageResult = await stage.execute(context);
        if (!stageResult.continue) {
          return stageResult.result;
        }
      }

      // If all stages completed but no result was set, this is a logic error.
      // The interpret stage should always produce a result.
      if (context.result) {
        return context.result;
      }

      // Fallback: should never reach here with a properly configured pipeline.
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        env: Object.create(null),
      };
    } finally {
      // Always clean up the defense-in-depth handle
      context.defenseHandle?.deactivate();
    }
  }
}
