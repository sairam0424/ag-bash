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

    // Run optional async prepare hooks AFTER transform, BEFORE interpret, so
    // a plugin can set up VFS state its emitted commands depend on (e.g. the
    // TeePlugin creates its capture-output directory, mirroring the `mkdir -p`
    // a user would run before piping into `tee /dir/file`). Operates on the
    // live execution VFS the transformed script runs against.
    for (const plugin of this.plugins) {
      if (plugin.prepare) {
        await plugin.prepare(context.bash.fs);
      }
    }

    context.ast = ast;
    context.metadata = meta;
    return { continue: true, context };
  }
}
