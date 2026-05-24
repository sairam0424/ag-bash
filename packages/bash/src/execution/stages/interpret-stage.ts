/**
 * InterpretStage - Interpreter creation and script execution.
 *
 * Creates the Interpreter instance with appropriate options and
 * runs the parsed AST, producing a BashExecResult. If a defense
 * handle is active, execution runs inside its sandboxed context.
 */

import type { AgenticHealer } from "../../agentic/agentic-healer.js";
import type { Bash, BashOptions, ExecOptions } from "../../Bash.js";
import type { DebuggerBridge, InterpreterOptions } from "../../interpreter/index.js";
import { Interpreter } from "../../interpreter/index.js";
import type { ExecutionLimits } from "../../limits.js";
import type { SemanticEngine } from "../../lsp/semantic-engine.js";
import type { SecureFetch } from "../../network/index.js";
import type { CommandRegistry, BashExecResult, FeatureCoverageWriter, TraceCallback } from "../../types.js";
import type { MountableFs } from "../../fs/mountable-fs/index.js";
import type { PipelineContext, PipelineStage, StageResult } from "../types.js";

/**
 * Configuration needed by the interpret stage that comes from the Bash instance.
 * These are set once at pipeline construction time.
 */
export interface InterpretStageConfig {
  fs: MountableFs;
  commands: CommandRegistry;
  limits: Required<ExecutionLimits>;
  execFn: (commandLine: string, options?: ExecOptions) => Promise<BashExecResult>;
  secureFetch: SecureFetch | undefined;
  sleepFn: ((ms: number) => Promise<void>) | undefined;
  traceFn: TraceCallback | undefined;
  coverageWriter: FeatureCoverageWriter | undefined;
  jsBootstrapCode: string | undefined;
  onCommandNotFound: BashOptions["onCommandNotFound"];
  agentic: boolean;
  debugger: DebuggerBridge | undefined;
  semanticEngine: SemanticEngine;
  agenticHealer: AgenticHealer | undefined;
  bash: Bash;
}

export class InterpretStage implements PipelineStage {
  readonly name = "interpret";

  private readonly config: InterpretStageConfig;

  constructor(config: InterpretStageConfig) {
    this.config = config;
  }

  async execute(context: PipelineContext): Promise<StageResult> {
    const { ast, options, execState, defenseHandle, metadata } = context;

    if (ast === undefined) {
      // Should never happen if parse stage ran, but guard defensively
      const fallback: BashExecResult = {
        stdout: "",
        stderr: "bash: internal error: no AST available\n",
        exitCode: 2,
        env: Object.create(null),
      };
      return { continue: false, result: fallback };
    }

    const defenseBox = defenseHandle
      ? { isEnabled: () => true }
      : undefined;

    const interpreterOptions: InterpreterOptions = {
      fs: this.config.fs,
      commands: this.config.commands,
      limits: this.config.limits,
      exec: this.config.execFn,
      fetch: this.config.secureFetch,
      sleep: this.config.sleepFn,
      trace: this.config.traceFn,
      coverage: this.config.coverageWriter,
      requireDefenseContext: defenseBox?.isEnabled() === true,
      jsBootstrapCode: this.config.jsBootstrapCode,
      onCommandNotFound: this.config.onCommandNotFound,
      agentic: this.config.agentic,
      getRegisteredCommands: () => Array.from(this.config.commands.keys()),
      debugger: options?.debugger ?? this.config.debugger,
      semanticEngine: options?.semanticEngine ?? this.config.semanticEngine,
      agenticHealer: options?.agenticHealer ?? this.config.agenticHealer,
      sharedBus: context.services.sharedBus,
      bash: this.config.bash,
    };

    const interpreter = new Interpreter(interpreterOptions, execState);

    const executeScript = async (): Promise<BashExecResult> => {
      const result = await interpreter.executeScript(ast);
      const execResult = result as BashExecResult;
      if (metadata) {
        execResult.metadata = metadata;
      }
      return execResult;
    };

    const execResult = await (defenseHandle
      ? defenseHandle.run(executeScript)
      : executeScript());

    context.result = execResult;
    return { continue: true, context };
  }
}
