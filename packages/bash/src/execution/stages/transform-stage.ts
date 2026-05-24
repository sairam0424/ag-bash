/**
 * TransformStage - BashTransformPipeline plugin execution.
 *
 * Applies registered transform plugins to the AST, collecting
 * metadata into a null-prototype object to prevent pollution.
 */

import { mergeToNullPrototype } from "../../helpers/env.js";
import type { TransformPlugin } from "../../transform/types.js";
import type { PipelineContext, PipelineStage, StageResult } from "../types.js";

export class TransformStage implements PipelineStage {
  readonly name = "transform";

  // biome-ignore lint/suspicious/noExplicitAny: type-erased plugin storage for untyped API
  private readonly plugins: TransformPlugin<any>[];

  // biome-ignore lint/suspicious/noExplicitAny: type-erased plugin storage for untyped API
  constructor(plugins: TransformPlugin<any>[]) {
    this.plugins = plugins;
  }

  async execute(context: PipelineContext): Promise<StageResult> {
    if (this.plugins.length === 0 || context.ast === undefined) {
      return { continue: true, context };
    }

    let ast = context.ast;
    let meta: Record<string, unknown> = Object.create(null);

    for (const plugin of this.plugins) {
      const pluginResult = plugin.transform({ ast, metadata: meta });
      ast = pluginResult.ast;
      if (pluginResult.metadata) {
        meta = mergeToNullPrototype(meta, pluginResult.metadata);
      }
    }

    context.ast = ast;
    context.metadata = meta;
    return { continue: true, context };
  }
}
