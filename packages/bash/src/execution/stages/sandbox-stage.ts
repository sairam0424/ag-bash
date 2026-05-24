/**
 * SandboxStage - DefenseInDepthBox activation.
 *
 * Activates the defense-in-depth sandbox before script interpretation.
 * The handle is stored on the context for cleanup in the pipeline's
 * finally block.
 */

import {
  DefenseInDepthBox,
} from "../../security/defense-in-depth-box.js";
import type { DefenseInDepthConfig } from "../../security/types.js";
import type { PipelineContext, PipelineStage, StageResult } from "../types.js";

export class SandboxStage implements PipelineStage {
  readonly name = "sandbox";

  private readonly config: DefenseInDepthConfig | boolean | undefined;

  constructor(config: DefenseInDepthConfig | boolean | undefined) {
    this.config = config;
  }

  async execute(context: PipelineContext): Promise<StageResult> {
    if (this.config) {
      const box = DefenseInDepthBox.getInstance(this.config);
      context.defenseHandle = box.activate();
    }
    return { continue: true, context };
  }
}
