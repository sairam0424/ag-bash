import type { ScriptNode } from "../ast/types.js";
import type { IFileSystem } from "../fs/interface.js";

export interface TransformPlugin<
  TMetadata extends object = Record<string, unknown>,
> {
  name: string;
  transform(context: TransformContext): TransformResult<TMetadata>;
  /**
   * Optional async hook run by the execution pipeline AFTER `transform`,
   * BEFORE the transformed script is interpreted. Lets a plugin set up
   * VFS state its emitted commands depend on (e.g. the TeePlugin creates
   * its capture-output directory here, mirroring the `mkdir -p` a user
   * would run before piping into `tee /some/dir/file`).
   *
   * Pure AST→string transformers (BashTransformPipeline.transform) never
   * call this, so it cannot affect serialized transform output.
   */
  prepare?(fs: IFileSystem): Promise<void>;
}

export interface TransformContext {
  ast: ScriptNode;
  metadata: Record<string, unknown>;
}

export interface TransformResult<
  TMetadata extends object = Record<string, unknown>,
> {
  ast: ScriptNode;
  metadata?: TMetadata;
}

export interface BashTransformResult<
  TMetadata extends object = Record<string, unknown>,
> {
  script: string;
  ast: ScriptNode;
  metadata: TMetadata;
}
