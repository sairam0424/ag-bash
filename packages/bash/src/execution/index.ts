/**
 * Execution Pipeline - barrel export.
 *
 * Provides the composable pipeline architecture that replaces the
 * monolithic Bash.exec() method internals.
 */

export { ExecutionPipeline } from "./ExecutionPipeline.js";
export { NormalizeStage } from "./stages/normalize-stage.js";
export { ParseStage } from "./stages/parse-stage.js";
export { TransformStage } from "./stages/transform-stage.js";
export { SandboxStage } from "./stages/sandbox-stage.js";
export { InterpretStage } from "./stages/interpret-stage.js";
export type { InterpretStageConfig } from "./stages/interpret-stage.js";
export { PersistStage } from "./stages/persist-stage.js";
export type { PersistCallback } from "./stages/persist-stage.js";
export { categorizeError } from "./stages/error-stage.js";
export type {
  PipelineContext,
  PipelineStage,
  StageResult,
} from "./types.js";
