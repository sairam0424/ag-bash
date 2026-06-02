/**
 * Interpreter - AST Execution Engine
 *
 * Main interpreter class that executes bash AST nodes.
 * Delegates to specialized modules for:
 * - Word expansion (expansion.ts)
 * - Arithmetic evaluation (arithmetic.ts)
 * - Conditional evaluation (conditionals.ts)
 * - Built-in commands (builtins.ts)
 * - Redirections (redirections.ts)
 */

import { AgenticHealer } from "../agentic/agentic-healer.js";
import type {
  ArithmeticCommandNode,
  CommandNode,
  ConditionalCommandNode,
  GroupNode,
  HereDocNode,
  PipelineNode,
  ScriptNode,
  SimpleCommandNode,
  StatementNode,
  SubshellNode,
  WordNode,
} from "../ast/types.js";
import type { IFileSystem } from "../fs/interface.js";
import { sanitizeErrorMessage } from "../fs/sanitize-error.js";
import { mapToRecord } from "../helpers/env.js";
import type { ExecutionLimits } from "../limits.js";
import { SemanticEngine } from "../lsp/semantic-engine.js";
import type { SecureFetch } from "../network/index.js";
import { AgTrace } from "../observability/ag-trace.js";
import { ParseException } from "../parser/types.js";
import {
  DefenseInDepthBox,
  SecurityViolationError,
} from "../security/defense-in-depth-box.js";
import type { SharedStateBus } from "../services/SharedStateBus.js";
import type {
  CommandRegistry,
  ExecResult,
  FeatureCoverageWriter,
  Observation,
  OutputSink,
  TraceCallback,
} from "../types.js";
import { expandAlias as expandAliasHelper } from "./alias-expansion.js";
import { evaluateArithmetic } from "./arithmetic.js";
import {
  expandLocalArrayAssignment as expandLocalArrayAssignmentHelper,
  expandScalarAssignmentArg as expandScalarAssignmentArgHelper,
} from "./assignment-expansion.js";
import {
  type BuiltinDispatchContext,
  dispatchBuiltin,
  executeExternalCommand,
} from "./builtin-dispatch.js";
import { findCommandInPath as findCommandInPathHelper } from "./command-resolution.js";
import { evaluateConditional } from "./conditionals.js";
import {
  executeCase,
  executeCStyleFor,
  executeFor,
  executeIf,
  executeUntil,
  executeWhile,
} from "./control-flow.js";
import type { DebuggerBridge } from "./debugger/debugger.js";
import {
  ArithmeticError,
  BadSubstitutionError,
  BraceExpansionError,
  BreakError,
  ContinueError,
  ErrexitError,
  ExecutionAbortedError,
  ExecutionLimitError,
  ExitError,
  GlobError,
  NounsetError,
  PosixFatalError,
  ReturnError,
} from "./errors.js";
import {
  expandHereDocContent,
  expandWord,
  expandWordWithGlob,
} from "./expansion.js";
import { executeFunctionDef } from "./functions.js";
import { OutputBuffer } from "./helpers/output-buffer.js";
import {
  checkFdLimit,
  result as createExecResult,
  failure,
  OK,
  testResult,
  throwExecutionLimit,
} from "./helpers/result.js";
import { isPosixSpecialBuiltin } from "./helpers/shell-constants.js";
import {
  isWordLiteralMatch,
  parseRwFdContent,
} from "./helpers/word-matching.js";
import { traceSimpleCommand } from "./helpers/xtrace.js";
import { executePipeline as executePipelineHelper } from "./pipeline-execution.js";
import {
  applyRedirections,
  preOpenOutputRedirects,
  processFdVariableRedirections,
} from "./redirections.js";
import { processAssignments } from "./simple-command-assignments.js";
import {
  executeGroup as executeGroupHelper,
  executeSubshell as executeSubshellHelper,
  executeUserScript as executeUserScriptHelper,
} from "./subshell-group.js";
import { executeErrTrap, executeExitTrap } from "./trap-execution.js";
import type { InterpreterContext, InterpreterState } from "./types.js";

export type { InterpreterContext, InterpreterState } from "./types.js";

// ============================================================================
// Performance Helpers (Phase 2)
// ============================================================================

/**
 * 2.2 — Deferred Env Copy
 * Instead of eagerly converting the env Map into a Record on every completion,
 * return a lazy getter that only materializes the record when accessed.
 * The Map is snapshotted at call time so later mutations don't affect it.
 */
function withLazyEnv(
  result: Omit<ExecResult, "env"> & { env?: Record<string, string> },
  envMap: Map<string, string>,
): ExecResult {
  const snapshot = new Map(envMap);
  // @banned-pattern-ignore: type annotation only; the cached value is always the
  // null-prototype object returned by mapToRecord(), never a plain {} literal.
  let cachedEnv: Record<string, string> | undefined;
  return Object.defineProperty(result as ExecResult, "env", {
    get() {
      return (cachedEnv ??= mapToRecord(snapshot));
    },
    enumerable: true,
    configurable: true,
  });
}

/**
 * 2.3 — Hot-Path Object Spread Elimination
 * Mutate the result's stderr in-place by prepending a prefix.
 * Avoids creating a new object via { ...result, stderr: ... } on hot paths.
 *
 * SAFETY: ExecResult objects on these paths are freshly created and immediately
 * returned up the call stack — they are not shared with event emitters or stored.
 * If the object is frozen (e.g., the singleton OK), a shallow copy is returned instead.
 */
function prependStderr(result: ExecResult, prefix: string): ExecResult {
  if (!prefix) {
    return result;
  }
  if (Object.isFrozen(result)) {
    return { ...result, stderr: prefix + result.stderr };
  }
  result.stderr = prefix + result.stderr;
  return result;
}

export interface InterpreterOptions {
  fs: IFileSystem;
  commands: CommandRegistry;
  limits: Required<ExecutionLimits>;
  exec: (
    script: string,
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      replaceEnv?: boolean;
      signal?: AbortSignal;
      args?: string[];
    },
  ) => Promise<ExecResult>;
  fetch?: SecureFetch;
  sleep?: (ms: number) => Promise<void>;
  trace?: TraceCallback;
  coverage?: FeatureCoverageWriter;
  requireDefenseContext?: boolean;
  jsBootstrapCode?: string;
  onCommandNotFound?: (
    command: string,
    args: string[],
  ) => Promise<ExecResult | null>;
  /** Returns list of all registered command names */
  getRegisteredCommands?: () => string[];
  /** If true, enables agentic behavior for the shell */
  agentic?: boolean;
  /** Optional debugger implementation */
  debugger?: DebuggerBridge;
  /** Optional semantic engine implementation */
  semanticEngine?: SemanticEngine;
  /** Optional agentic healer implementation */
  agenticHealer?: AgenticHealer;
  /** Optional shared state bus implementation */
  sharedBus?: SharedStateBus;
  /** Reference to the parent Bash instance */
  bash?: any;
  /**
   * Optional opt-in sink for incremental (true) streaming of stdout/stderr.
   * When undefined, execution is byte-identical to the buffered path.
   */
  sink?: OutputSink;
}

/**
 * Shell Interpreter
 *
 * Implements the core bash execution logic by traversing the AST.
 */
export class Interpreter {
  private ctx: InterpreterContext;
  private estimatedMemoryBytes = 0;
  private statementsSinceMemoryCheck = 0;

  // 2.6 — Incremental Exported Env: cached record to avoid full rebuild each call
  private cachedExportedEnv: Record<string, string> | null = null;

  constructor(options: InterpreterOptions, state: InterpreterState) {
    this.ctx = {
      state,
      fs: options.fs,
      commands: options.commands,
      limits: options.limits,
      execFn: options.exec,
      executeScript: (node: ScriptNode) => this.executeScript(node),
      executeStatement: (node: StatementNode) => this.executeStatement(node),
      executeCommand: (node: CommandNode, stdin: string) =>
        this.executeCommand(node, stdin),
      fetch: options.fetch,
      sleep: options.sleep,
      trace: options.trace,
      coverage: options.coverage,
      requireDefenseContext: options.requireDefenseContext,
      jsBootstrapCode: options.jsBootstrapCode,
      onCommandNotFound: options.onCommandNotFound,
      getRegisteredCommands: options.getRegisteredCommands,
      agentic: options.agentic,
      debugger: options.debugger,
      semanticEngine:
        options.semanticEngine ||
        (options.agentic ? new SemanticEngine() : undefined),
      agenticHealer:
        options.agenticHealer ||
        (options.agentic ? new AgenticHealer() : undefined),
      sharedBus: options.sharedBus || options.bash?.services?.sharedBus,
      bash: options.bash,
      sink: options.sink,
    };
  }

  /**
   * Fail closed if defense is expected but async context is missing.
   */
  private assertDefenseContext(phase: string): void {
    if (!this.ctx.requireDefenseContext) return;
    if (DefenseInDepthBox.isInSandboxedContext()) return;

    const message = `interpreter ${phase} attempted outside defense context`;
    throw new SecurityViolationError(message, {
      timestamp: Date.now(),
      type: "missing_defense_context",
      message,
      path: "DefenseInDepthBox.context",
      stack: new Error().stack,
      executionId: DefenseInDepthBox.getCurrentExecutionId(),
    });
  }

  /**
   * Build environment record containing only exported variables.
   * In bash, only exported variables are passed to child processes.
   * This includes both permanently exported variables (via export/declare -x)
   * and temporarily exported variables (prefix assignments like FOO=bar cmd).
   *
   * 2.6 — Incremental Exported Env: returns a cached record when the exported
   * variable set has not changed since the last call, avoiding a full rebuild
   * on every external command execution.
   */
  private buildExportedEnv(): Record<string, string> {
    // Fast path: if membership hasn't changed, validate cached values are current.
    // This is cheaper than a full rebuild because we skip object allocation when
    // values haven't changed (common case: repeated external commands in loops).
    if (this.cachedExportedEnv !== null && !this.ctx.state.exportedEnvDirty) {
      const cached = this.cachedExportedEnv;
      let valid = true;
      for (const name of Object.keys(cached)) {
        const current = this.ctx.state.env.get(name);
        if (current !== cached[name]) {
          valid = false;
          break;
        }
      }
      if (valid) {
        return cached;
      }
    }

    const exportedVars = this.ctx.state.exportedVars;
    const tempExportedVars = this.ctx.state.tempExportedVars;

    // Combine both exported and temp exported vars
    const allExported = new Set<string>();
    if (exportedVars) {
      for (const name of exportedVars) {
        allExported.add(name);
      }
    }
    if (tempExportedVars) {
      for (const name of tempExportedVars) {
        allExported.add(name);
      }
    }

    if (allExported.size === 0) {
      // No exported vars - return empty env
      // This matches bash behavior where variables must be exported to be visible to children
      const empty: Record<string, string> = Object.create(null);
      this.cachedExportedEnv = empty;
      this.ctx.state.exportedEnvDirty = false;
      return empty;
    }

    // Use null-prototype to prevent prototype pollution via user-controlled variable names
    const env: Record<string, string> = Object.create(null);
    for (const name of allExported) {
      const value = this.ctx.state.env.get(name);
      if (value !== undefined) {
        env[name] = value;
      }
    }

    this.cachedExportedEnv = env;
    this.ctx.state.exportedEnvDirty = false;
    return env;
  }

  async executeScript(node: ScriptNode): Promise<ExecResult> {
    this.assertDefenseContext("execution");

    const stdoutBuf = new OutputBuffer();
    const stderrBuf = new OutputBuffer();
    let exitCode = 0;
    const observations: Observation[] = [];
    const maxOutputSize = this.ctx.limits.maxOutputSize;

    // Opt-in incremental streaming sink. Captured once; only invoked when a
    // sink is present so the buffered path stays byte-identical with zero
    // overhead. stdout is emitted before stderr within a single append so the
    // per-statement production order is preserved across both streams.
    const sink = this.ctx.sink;
    const emit = sink
      ? (nextStdout: string, nextStderr: string): void => {
          if (nextStdout) sink({ type: "stdout", data: nextStdout });
          if (nextStderr) sink({ type: "stderr", data: nextStderr });
        }
      : undefined;

    const appendOutput = (nextStdout: string, nextStderr: string): void => {
      if (
        stdoutBuf.length +
          stderrBuf.length +
          nextStdout.length +
          nextStderr.length >
        maxOutputSize
      ) {
        throwExecutionLimit(
          `total output size exceeded (>${maxOutputSize} bytes), increase executionLimits.maxOutputSize`,
          "output_size",
        );
      }
      stdoutBuf.push(nextStdout);
      stderrBuf.push(nextStderr);
      emit?.(nextStdout, nextStderr);
    };

    for (const statement of node.statements) {
      try {
        const result = await this.executeStatement(statement);
        appendOutput(result.stdout, result.stderr);
        exitCode = result.exitCode;
        if (result.observations) {
          observations.push(...result.observations);
        }
        this.ctx.state.lastExitCode = exitCode;
        this.ctx.state.env.set("?", String(exitCode));
      } catch (error) {
        if (error instanceof ExitError) {
          // Fire EXIT trap before propagating exit
          const exitTrapResult = await executeExitTrap(this.ctx);
          if (exitTrapResult) {
            error.prependOutput(exitTrapResult.stdout, exitTrapResult.stderr);
          }
          error.prependOutput(stdoutBuf.toString(), stderrBuf.toString());
          throw error;
        }
        if (error instanceof PosixFatalError) {
          appendOutput(error.stdout, error.stderr);
          exitCode = error.exitCode;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env.set("?", String(exitCode));
          return withLazyEnv(
            {
              stdout: stdoutBuf.toString(),
              stderr: stderrBuf.toString(),
              exitCode,
              observations,
            },
            this.ctx.state.env,
          );
        }
        const errorName = error instanceof Error ? error.name : "";
        if (
          error instanceof ExecutionLimitError ||
          errorName === "ExecutionLimitError"
        ) {
          throw error;
        }
        if (error instanceof ErrexitError) {
          appendOutput(error.stdout, error.stderr);
          exitCode = error.exitCode;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env.set("?", String(exitCode));
          return withLazyEnv(
            {
              stdout: stdoutBuf.toString(),
              stderr: stderrBuf.toString(),
              exitCode,
              observations,
            },
            this.ctx.state.env,
          );
        }
        if (error instanceof NounsetError) {
          appendOutput(error.stdout, error.stderr);
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env.set("?", String(exitCode));
          return withLazyEnv(
            {
              stdout: stdoutBuf.toString(),
              stderr: stderrBuf.toString(),
              exitCode,
              observations: [AgTrace.analyzeError(error)],
            },
            this.ctx.state.env,
          );
        }
        if (error instanceof BadSubstitutionError) {
          appendOutput(error.stdout, error.stderr);
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env.set("?", String(exitCode));
          return withLazyEnv(
            {
              stdout: stdoutBuf.toString(),
              stderr: stderrBuf.toString(),
              exitCode,
              observations: [AgTrace.analyzeError(error)],
            },
            this.ctx.state.env,
          );
        }
        if (error instanceof ArithmeticError) {
          appendOutput(error.stdout, error.stderr);
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env.set("?", String(exitCode));
          continue;
        }
        if (error instanceof BraceExpansionError) {
          appendOutput(error.stdout, error.stderr);
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          this.ctx.state.env.set("?", String(exitCode));
          continue;
        }
        if (error instanceof BreakError || error instanceof ContinueError) {
          if (this.ctx.state.loopDepth > 0) {
            error.prependOutput(stdoutBuf.toString(), stderrBuf.toString());
            throw error;
          }
          appendOutput(error.stdout, error.stderr);
          continue;
        }
        if (error instanceof ReturnError) {
          error.prependOutput(stdoutBuf.toString(), stderrBuf.toString());
          throw error;
        }
        if (
          error instanceof SecurityViolationError ||
          errorName === "SecurityViolationError"
        ) {
          throw error;
        }
        throw error;
      }
    }

    // Fire EXIT trap at the end of script execution
    const exitTrapResult = await executeExitTrap(this.ctx);
    if (exitTrapResult) {
      stdoutBuf.push(exitTrapResult.stdout);
      stderrBuf.push(exitTrapResult.stderr);
      emit?.(exitTrapResult.stdout, exitTrapResult.stderr);
    }

    return withLazyEnv(
      {
        stdout: stdoutBuf.toString(),
        stderr: stderrBuf.toString(),
        exitCode,
        observations,
      },
      this.ctx.state.env,
    );
  }

  /**
   * Execute a user script file found in PATH.
   */
  private async executeUserScript(
    scriptPath: string,
    args: string[],
    stdin = "",
  ): Promise<ExecResult> {
    return executeUserScriptHelper(this.ctx, scriptPath, args, stdin, (ast) =>
      this.executeScript(ast),
    );
  }

  public async executeStatement(node: StatementNode): Promise<ExecResult> {
    try {
      this.assertDefenseContext("statement");

      // Ag-Intelligence: Statement-level debugger hook
      if (this.ctx.debugger) {
        await this.ctx.debugger.onBeforeStatement(node, this.ctx.state);
      }

      // Ag-Intelligence: Semantic AST analysis hook
      if (this.ctx.semanticEngine) {
        await this.ctx.semanticEngine.indexStatement(node);
      }

      // Check for abort signal (cooperative cancellation by timeout command)
      if (this.ctx.state.signal?.aborted) {
        throw new ExecutionAbortedError();
      }

      this.ctx.state.commandCount++;
      if (this.ctx.state.commandCount > this.ctx.limits.maxCommandCount) {
        throwExecutionLimit(
          `too many commands executed (>${this.ctx.limits.maxCommandCount}), increase executionLimits.maxCommandCount`,
          "commands",
        );
      }

      // Performance: Memory accounting
      this.statementsSinceMemoryCheck++;
      if (this.statementsSinceMemoryCheck >= 100) {
        this.estimatedMemoryBytes = this.estimateMemoryUsage();
        this.statementsSinceMemoryCheck = 0;
      }
      if (
        this.estimatedMemoryBytes > this.ctx.limits.maxMemoryAccountingBytes
      ) {
        throwExecutionLimit(
          `memory limit exceeded: ${Math.round(this.estimatedMemoryBytes / 1024 / 1024)}MB exceeds ${Math.round(this.ctx.limits.maxMemoryAccountingBytes / 1024 / 1024)}MB limit`,
          "memory",
        );
      }

      // Performance: CPU time accounting (basic check)
      const cpuTime = Date.now() - this.ctx.state.executionStartTime;
      if (cpuTime > this.ctx.limits.maxCpuMs) {
        throwExecutionLimit(
          `CPU time limit exceeded: ${cpuTime}ms exceeds ${this.ctx.limits.maxCpuMs}ms limit`,
          "cpu_time",
        );
      }

      // Performance: Network traffic accounting
      if (
        this.ctx.state.networkTrafficBytes >
        this.ctx.limits.maxNetworkTrafficBytes
      ) {
        throwExecutionLimit(
          `network traffic limit exceeded: ${Math.round(this.ctx.state.networkTrafficBytes / 1024 / 1024)}MB exceeds ${Math.round(this.ctx.limits.maxNetworkTrafficBytes / 1024 / 1024)}MB limit`,
          "network_traffic",
        );
      }

      // Check for deferred syntax error
      if (node.deferredError) {
        throw new ParseException(node.deferredError.message, node.line ?? 1, 1);
      }

      // noexec mode (set -n)
      if (this.ctx.state.options.noexec) {
        return OK;
      }

      // Reset errexitSafe at the start of each statement
      this.ctx.state.errexitSafe = false;

      let stdout = "";
      let stderr = "";
      const observations: Observation[] = [];

      // verbose mode (set -v)
      if (
        this.ctx.state.options.verbose &&
        !this.ctx.state.suppressVerbose &&
        node.sourceText
      ) {
        stderr += `${node.sourceText}\n`;
      }
      let exitCode = 0;
      let lastExecutedIndex = -1;
      let lastPipelineNegated = false;

      for (let i = 0; i < node.pipelines.length; i++) {
        const pipeline = node.pipelines[i];
        const operator = i > 0 ? node.operators[i - 1] : null;

        if (operator === "&&" && exitCode !== 0) continue;
        if (operator === "||" && exitCode === 0) continue;

        const result = await this.executePipeline(pipeline);
        stdout += result.stdout;
        stderr += result.stderr;
        exitCode = result.exitCode;
        if (result.observations) {
          observations.push(...result.observations);
        }
        lastExecutedIndex = i;
        lastPipelineNegated = pipeline.negated;

        // Update $? after each pipeline
        this.ctx.state.lastExitCode = exitCode;
        this.ctx.state.env.set("?", String(exitCode));
      }

      // Track whether this exit code is "safe" for errexit purposes
      const wasShortCircuited = lastExecutedIndex < node.pipelines.length - 1;
      const innerWasSafe = this.ctx.state.errexitSafe;
      this.ctx.state.errexitSafe =
        wasShortCircuited || lastPipelineNegated || innerWasSafe;

      // Fire ERR trap when a command fails outside condition context
      if (
        exitCode !== 0 &&
        lastExecutedIndex === node.pipelines.length - 1 &&
        !lastPipelineNegated &&
        !this.ctx.state.inCondition &&
        !innerWasSafe
      ) {
        const errTrapResult = await executeErrTrap(
          this.ctx,
          this.ctx.state.inCondition,
          lastPipelineNegated,
        );
        if (errTrapResult) {
          stdout += errTrapResult.stdout;
          stderr += errTrapResult.stderr;
        }
      }

      // Check errexit (set -e)
      if (
        this.ctx.state.options.errexit &&
        exitCode !== 0 &&
        lastExecutedIndex === node.pipelines.length - 1 &&
        !lastPipelineNegated &&
        !this.ctx.state.inCondition &&
        !innerWasSafe
      ) {
        throw new ErrexitError(exitCode, stdout, stderr, observations);
      }

      return { stdout, stderr, exitCode, observations };
    } catch (error: any) {
      if (
        this.ctx.agentic &&
        this.ctx.agenticHealer &&
        error instanceof Error
      ) {
        const suggestion = await this.ctx.agenticHealer.diagnose(
          "",
          {
            stdout: "",
            stderr: (error as any).stderr || error.message || "",
            exitCode: 1,
          },
          this.ctx,
          error,
        );
        if (suggestion) {
          const healerMessage = `\n[Agentic Healer] ${suggestion}\n`;
          const anyError = error as any;
          if (anyError.stderr !== undefined) {
            anyError.stderr += healerMessage;
          } else {
            error.message += healerMessage;
          }
        }
      }
      throw error;
    }
  }

  public async executePipeline(node: PipelineNode): Promise<ExecResult> {
    const result = await executePipelineHelper(this.ctx, node, (cmd, stdin) =>
      this.executeCommand(cmd, stdin),
    );

    // Ag-Intelligence: Agentic Healer diagnostic hook for command-not-found failures (exit code 127)
    if (this.ctx.agentic && this.ctx.agenticHealer && result.exitCode === 127) {
      const healer = this.ctx.agenticHealer as AgenticHealer;

      // Reconstruct the full command text from the AST for healing
      let fullCommand = "";
      const firstCmd = node.commands[0];
      if (firstCmd?.type === "SimpleCommand") {
        const parts: string[] = [];
        if (firstCmd.name?.parts) {
          for (const p of firstCmd.name.parts) {
            if ("value" in p) parts.push(p.value);
          }
        }
        for (const arg of firstCmd.args) {
          const argParts: string[] = [];
          for (const p of arg.parts) {
            if ("value" in p) argParts.push(p.value);
          }
          if (argParts.length > 0) parts.push(argParts.join(""));
        }
        fullCommand = parts.join(" ");
      }
      if (!fullCommand) {
        const stderrMatch = result.stderr.match(
          /:\s*(.+?):\s*command not found/,
        );
        if (stderrMatch) fullCommand = stderrMatch[1].trim();
      }

      // Active self-healing: attempt to correct and re-execute
      const execFn = async (cmd: string): Promise<ExecResult> => {
        return this.ctx.execFn(cmd, { cwd: this.ctx.state.cwd });
      };
      const healedResult = await healer.heal(fullCommand, result, execFn);
      if (healedResult) {
        return healedResult;
      }

      // Fall back to diagnostic suggestion
      const suggestion = await healer.diagnose(fullCommand, result, this.ctx);
      if (suggestion) {
        result.stderr = `${result.stderr}\n[Agentic Healer] ${suggestion}\n`;
        return result;
      }
    }

    return result;
  }

  private async executeCommand(
    node: CommandNode,
    stdin: string,
  ): Promise<ExecResult> {
    this.assertDefenseContext("command");

    this.ctx.coverage?.hit(`bash:cmd:${node.type}`);
    switch (node.type) {
      case "SimpleCommand":
        return this.executeSimpleCommand(node, stdin);
      case "If":
        return executeIf(this.ctx, node);
      case "For":
        return executeFor(this.ctx, node);
      case "CStyleFor":
        return executeCStyleFor(this.ctx, node);
      case "While":
        return executeWhile(this.ctx, node, stdin);
      case "Until":
        return executeUntil(this.ctx, node);
      case "Case":
        return executeCase(this.ctx, node);
      case "Subshell":
        return this.executeSubshell(node, stdin);
      case "Group":
        return this.executeGroup(node, stdin);
      case "FunctionDef":
        return executeFunctionDef(this.ctx, node);
      case "ArithmeticCommand":
        return this.executeArithmeticCommand(node);
      case "ConditionalCommand":
        return this.executeConditionalCommand(node);
      default:
        return OK;
    }
  }

  /**
   * Estimate memory usage of the current interpreter state.
   */
  private estimateMemoryUsage(): number {
    let bytes = 0;

    // Estimate environment variables
    for (const [key, value] of this.ctx.state.env) {
      bytes += key.length * 2 + value.length * 2;
    }

    // Estimate functions
    for (const [name, _node] of this.ctx.state.functions) {
      bytes += name.length * 2;
      // Rough estimate for AST node structure
      bytes += 1000;
    }

    // Estimate file descriptors
    if (this.ctx.state.fileDescriptors) {
      for (const [_fd, content] of this.ctx.state.fileDescriptors) {
        bytes += 4 + content.length * 2;
      }
    }

    return bytes;
  }

  private async executeSimpleCommand(
    node: SimpleCommandNode,
    stdin: string,
  ): Promise<ExecResult> {
    try {
      return await this.executeSimpleCommandInner(node, stdin);
    } catch (error) {
      if (error instanceof GlobError) {
        // GlobError from failglob should return exit code 1 with error message
        return failure(error.stderr);
      }
      // ArithmeticError in expansion (e.g., echo $((42x))) should terminate the script
      // Let the error propagate - it will be caught by the top-level error handler
      throw error;
    }
  }

  private async executeSimpleCommandInner(
    node: SimpleCommandNode,
    stdin: string,
  ): Promise<ExecResult> {
    // Update currentLine for $LINENO
    if (node.line !== undefined) {
      this.ctx.state.currentLine = node.line;
    }

    // Alias expansion: if expand_aliases is enabled and the command name is
    // a literal unquoted word that matches an alias, substitute it.
    // Keep expanding until no more alias expansion occurs (handles recursive aliases).
    // The aliasExpansionStack persists across iterations to prevent infinite loops.
    if (this.ctx.state.shoptOptions.expand_aliases && node.name) {
      let currentNode = node;
      let maxExpansions = 100; // Safety limit
      while (maxExpansions > 0) {
        const expandedNode = this.expandAlias(currentNode);
        if (expandedNode === currentNode) {
          break; // No expansion occurred
        }
        currentNode = expandedNode;
        maxExpansions--;
      }
      // Clear the alias expansion stack after all expansions are done
      this.aliasExpansionStack.clear();
      // Continue with the fully expanded node
      if (currentNode !== node) {
        node = currentNode;
      }
    }

    // Clear expansion stderr at the start
    this.ctx.state.expansionStderr = "";

    // Process all assignments (array, subscript, and scalar)
    const assignmentResult = await processAssignments(this.ctx, node);
    if (assignmentResult.error) {
      return assignmentResult.error;
    }
    const tempAssignments = assignmentResult.tempAssignments;
    const xtraceAssignmentOutput = assignmentResult.xtraceOutput;

    if (!node.name) {
      // No command name - could be assignment-only or redirect-only (bare redirects)
      // e.g., "x=5" (assignment-only) or "> file" (bare redirect to create empty file)

      // Handle bare redirections (no command, just redirects like "> file")
      // In bash, this creates/truncates the file and returns success
      if (node.redirections.length > 0) {
        // Process the redirects - this creates/truncates files as needed
        const redirectError = await preOpenOutputRedirects(
          this.ctx,
          node.redirections,
        );
        if (redirectError) {
          return redirectError;
        }
        // Apply redirections to empty result (for append, read redirects, etc.)
        const baseResult = createExecResult("", xtraceAssignmentOutput, 0);
        return applyRedirections(this.ctx, baseResult, node.redirections);
      }

      // Assignment-only command: preserve the exit code from command substitution
      // e.g., x=$(false) should set $? to 1, not 0
      // Also clear $_ - bash clears it for bare assignments
      this.ctx.state.lastArg = "";
      // Include any stderr from command substitutions (e.g., FOO=$(echo foo 1>&2))
      const stderrOutput =
        (this.ctx.state.expansionStderr || "") + xtraceAssignmentOutput;
      this.ctx.state.expansionStderr = "";
      return createExecResult("", stderrOutput, this.ctx.state.lastExitCode);
    }

    // Mark prefix assignment variables as temporarily exported for this command
    // In bash, FOO=bar cmd makes FOO visible in cmd's environment
    // EXCEPTION: For assignment builtins (readonly, declare, local, export, typeset),
    // temp bindings should NOT be exported to command substitutions in the arguments.
    // e.g., `FOO=foo readonly v=$(printenv.py FOO)` - the $(printenv.py FOO) should NOT see FOO.
    // This is because assignment builtins don't actually run as external commands that receive
    // an exported environment - they process their arguments in the current shell context.
    const isLiteralAssignmentBuiltinForExport =
      node.name &&
      isWordLiteralMatch(node.name, [
        "local",
        "declare",
        "typeset",
        "export",
        "readonly",
      ]);
    const tempExportedVars = Array.from(tempAssignments.keys());
    if (tempExportedVars.length > 0 && !isLiteralAssignmentBuiltinForExport) {
      this.ctx.state.tempExportedVars =
        this.ctx.state.tempExportedVars || new Set();
      for (const name of tempExportedVars) {
        this.ctx.state.tempExportedVars.add(name);
      }
      this.ctx.state.exportedEnvDirty = true;
    }

    // Process FD variable redirections ({varname}>file syntax)
    // This allocates FDs and sets variables before command execution
    const fdVarError = await processFdVariableRedirections(
      this.ctx,
      node.redirections,
    );
    if (fdVarError) {
      for (const [name, value] of tempAssignments) {
        if (value === undefined) this.ctx.state.env.delete(name);
        else this.ctx.state.env.set(name, value as string);
      }
      return fdVarError;
    }

    // Track source FD for stdin from read-write file descriptors
    // This allows the read builtin to update the FD's position after reading
    let stdinSourceFd = -1;

    for (const redir of node.redirections) {
      if (
        (redir.operator === "<<" || redir.operator === "<<-") &&
        redir.target.type === "HereDoc"
      ) {
        const hereDoc = redir.target as HereDocNode;
        const content = await expandHereDocContent(this.ctx, hereDoc);
        // If this is a non-standard fd (not 0), store in fileDescriptors for -u option
        const fd = redir.fd ?? 0;
        if (fd !== 0) {
          if (!this.ctx.state.fileDescriptors) {
            this.ctx.state.fileDescriptors = new Map();
          }
          checkFdLimit(this.ctx);
          this.ctx.state.fileDescriptors.set(fd, content);
        } else {
          stdin = content;
        }
        continue;
      }

      if (redir.operator === "<<<" && redir.target.type === "Word") {
        stdin = `${await expandWord(this.ctx, redir.target as WordNode)}\n`;
        continue;
      }

      if (redir.operator === "<" && redir.target.type === "Word") {
        try {
          const target = await expandWord(this.ctx, redir.target as WordNode);
          const filePath = this.ctx.fs.resolvePath(this.ctx.state.cwd, target);
          stdin = await this.ctx.fs.readFile(filePath);
        } catch {
          const target = await expandWord(this.ctx, redir.target as WordNode);
          for (const [name, value] of tempAssignments) {
            if (value === undefined) this.ctx.state.env.delete(name);
            else this.ctx.state.env.set(name, value as string);
          }
          return failure(`bash: ${target}: No such file or directory\n`);
        }
      }

      // Handle <& input redirection from file descriptor
      if (redir.operator === "<&" && redir.target.type === "Word") {
        const target = await expandWord(this.ctx, redir.target as WordNode);
        const sourceFd = Number.parseInt(target, 10);
        if (!Number.isNaN(sourceFd) && this.ctx.state.fileDescriptors) {
          const fdContent = this.ctx.state.fileDescriptors.get(sourceFd);
          if (fdContent !== undefined) {
            // Handle different FD content formats
            if (fdContent.startsWith("__rw__:")) {
              // Read/write mode: format is __rw__:pathLength:path:position:content
              const parsed = parseRwFdContent(fdContent);
              if (parsed) {
                // Return content starting from current position
                stdin = parsed.content.slice(parsed.position);
                stdinSourceFd = sourceFd;
              }
            } else if (
              fdContent.startsWith("__file__:") ||
              fdContent.startsWith("__file_append__:")
            ) {
              // These are output-only, can't read from them
            } else {
              // Plain content (from exec N< file or here-docs)
              stdin = fdContent;
            }
          }
        }
      }
    }

    const commandName = await expandWord(this.ctx, node.name);

    const args: string[] = [];
    const quotedArgs: boolean[] = [];

    // Handle local/declare/export/readonly arguments specially:
    // - For array assignments like `local a=(1 "2 3")`, preserve quote structure
    // - For scalar assignments like `local foo=$bar`, DON'T glob expand the value
    // This matches bash behavior where assignment values aren't subject to word splitting/globbing
    //
    // IMPORTANT: This special handling only applies when the command is a LITERAL keyword,
    // not when it's determined via variable expansion. For example:
    // - `export var=$x` -> no word splitting (literal export keyword)
    // - `e=export; $e var=$x` -> word splitting DOES occur (export via variable)
    //
    // This is because bash determines at parse time whether the command is an assignment builtin.
    const isLiteralAssignmentBuiltin =
      isWordLiteralMatch(node.name, [
        "local",
        "declare",
        "typeset",
        "export",
        "readonly",
      ]) &&
      (commandName === "local" ||
        commandName === "declare" ||
        commandName === "typeset" ||
        commandName === "export" ||
        commandName === "readonly");

    if (isLiteralAssignmentBuiltin) {
      for (const arg of node.args) {
        const arrayAssignResult = await expandLocalArrayAssignmentHelper(
          this.ctx,
          arg,
        );
        if (arrayAssignResult) {
          args.push(arrayAssignResult);
          quotedArgs.push(true);
        } else {
          // Check if this looks like a scalar assignment (name=value)
          // For assignments, we should NOT glob-expand the value part
          const scalarAssignResult = await expandScalarAssignmentArgHelper(
            this.ctx,
            arg,
          );
          if (scalarAssignResult !== null) {
            args.push(scalarAssignResult);
            quotedArgs.push(true);
          } else {
            // Not an assignment - use normal glob expansion
            const expanded = await expandWordWithGlob(this.ctx, arg);
            for (const value of expanded.values) {
              args.push(value);
              quotedArgs.push(expanded.quoted);
            }
          }
        }
      }
    } else {
      // Expand args even if command name is empty (they may have side effects)
      for (const arg of node.args) {
        const expanded = await expandWordWithGlob(this.ctx, arg);
        for (const value of expanded.values) {
          args.push(value);
          quotedArgs.push(expanded.quoted);
        }
      }
    }

    // Append extra args injected via exec({ args }) and consume them so only
    // the FIRST executed command receives them (spawnSync-like semantics). The
    // values bypass shell parsing entirely, so they are marked quoted to skip
    // any further word-splitting/globbing. Consumed once: cleared after use.
    const extraArgs = this.ctx.state.extraArgs;
    if (extraArgs) {
      for (const extra of extraArgs) {
        args.push(extra);
        quotedArgs.push(true);
      }
      this.ctx.state.extraArgs = undefined;
    }

    // Built-in commands are registered with CommandRegistry.
    // External commands are handled by the shell path lookup.
    let execResult: ExecResult;
    try {
      execResult = await this.runCommand(
        commandName,
        args,
        quotedArgs,
        stdin,
        false, // skipFunctions
        false, // useDefaultPath
        stdinSourceFd,
      );
    } catch (error: any) {
      // Re-throw control flow and fatal errors to be handled by the top-level Bash
      const errorName = error instanceof Error ? error.name : "";
      if (
        error instanceof SecurityViolationError ||
        error instanceof ExecutionLimitError ||
        error instanceof ExitError ||
        error instanceof ReturnError ||
        error instanceof BreakError ||
        error instanceof ContinueError ||
        error instanceof ErrexitError ||
        error instanceof ArithmeticError ||
        error instanceof PosixFatalError ||
        errorName === "SecurityViolationError" ||
        errorName === "ExecutionLimitError" ||
        errorName === "ExitError" ||
        errorName === "ReturnError" ||
        errorName === "BreakError" ||
        errorName === "ContinueError" ||
        errorName === "ErrexitError" ||
        errorName === "ArithmeticError" ||
        errorName === "PosixFatalError"
      ) {
        throw error;
      }
      // Catch unexpected command internal errors and treat as failure
      execResult = failure(
        `bash: ${commandName}: unexpected error: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}\n`,
      );
    }

    // Apply redirections if command succeeded (or even if it failed, bash applies them)
    const finalResult = await applyRedirections(
      this.ctx,
      execResult,
      node.redirections,
    );

    // Ag-Trace: Analyze failure if exitCode exists and is non-zero.
    // Source-emitted observations (already on finalResult) are the primary
    // channel; AgTrace is the FALLBACK. combineObservations dedups/merges so
    // the same failure is never double-emitted (A3).
    if (finalResult.exitCode !== 0) {
      const fresh = await AgTrace.analyze(
        this.ctx,
        commandName,
        args,
        finalResult,
      );
      if (fresh && fresh.length > 0) {
        // Immutability: return a NEW result rather than mutating finalResult.
        return {
          ...finalResult,
          observations: AgTrace.combineObservations(
            finalResult.observations ?? [],
            fresh,
          ),
        };
      }
    }

    return finalResult;
    // - x=''; $x is a no-op (empty, no args)
    // - x=''; $x Y runs command Y (empty command name, Y becomes command)
    // - `true` X runs command X (since `true` outputs nothing)
    // However, a literal empty string (like '') is "command not found".
    // however, a literal empty string (like '') is "command not found".
    if (!commandName) {
      const isOnlyExpansions = node.name?.parts.every(
        (p) =>
          p.type === "CommandSubstitution" ||
          p.type === "ParameterExpansion" ||
          p.type === "ArithmeticExpansion",
      );
      if (isOnlyExpansions) {
        // Empty result from variable/command substitution - word split removes it
        // If there are args, the first arg becomes the command name
        if (args.length > 0) {
          const newCommandName = args.shift() as string;
          quotedArgs.shift();
          return await this.runCommand(
            newCommandName,
            args,
            quotedArgs,
            stdin,
            false,
            false,
            stdinSourceFd,
          );
        }
        // No args - treat as no-op (status 0)
        // Preserve lastExitCode for command subs like $(exit 42)
        return createExecResult("", "", this.ctx.state.lastExitCode);
      }
      // Literal empty command name - command not found
      return failure("bash: : command not found\n", 127);
    }

    // Special handling for 'exec' with only redirections (no command to run)
    // In this case, the redirections apply persistently to the shell
    if (commandName === "exec" && (args.length === 0 || args[0] === "--")) {
      // Process persistent FD redirections
      // Note: {var}>file redirections are already handled by processFdVariableRedirections
      // which sets up the FD mapping persistently. We only need to handle explicit fd redirections here.
      for (const redir of node.redirections) {
        if (redir.target.type === "HereDoc") continue;

        // Skip FD variable redirections - already handled by processFdVariableRedirections
        if (redir.fdVariable) continue;

        const target = await expandWord(this.ctx, redir.target as WordNode);
        const fd =
          redir.fd ??
          (redir.operator === "<" || redir.operator === "<>" ? 0 : 1);

        let fds = this.ctx.state.fileDescriptors;
        if (!fds) {
          fds = new Map();
          this.ctx.state.fileDescriptors = fds;
        }

        switch (redir.operator) {
          case ">":
          case ">|": {
            // Open file for writing (truncate)
            const filePath = this.ctx.fs.resolvePath(
              this.ctx.state.cwd,
              target,
            );
            await this.ctx.fs.writeFile(filePath, "", "utf8"); // truncate
            checkFdLimit(this.ctx);
            fds?.set(fd, `__file__:${filePath}`);
            break;
          }
          case ">>": {
            // Open file for appending
            const filePath = this.ctx.fs.resolvePath(
              this.ctx.state.cwd,
              target,
            );
            checkFdLimit(this.ctx);
            fds?.set(fd, `__file_append__:${filePath}`);
            break;
          }
          case "<": {
            // Open file for reading - store its content
            const filePath = this.ctx.fs.resolvePath(
              this.ctx.state.cwd,
              target,
            );
            try {
              const content = await this.ctx.fs.readFile(filePath);
              checkFdLimit(this.ctx);
              fds?.set(fd, content);
            } catch {
              return failure(`bash: ${target}: No such file or directory\n`);
            }
            break;
          }
          case "<>": {
            // Open file for read/write
            // Format: __rw__:pathLength:path:position:content
            // pathLength allows parsing paths with colons
            // position tracks current file offset for read/write
            const filePath = this.ctx.fs.resolvePath(
              this.ctx.state.cwd,
              target,
            );
            try {
              const content = await this.ctx.fs.readFile(filePath);
              checkFdLimit(this.ctx);
              fds?.set(
                fd,
                `__rw__:${filePath.length}:${filePath}:0:${content}`,
              );
            } catch {
              // File doesn't exist - create empty
              await this.ctx.fs.writeFile(filePath, "", "utf8");
              checkFdLimit(this.ctx);
              fds?.set(fd, `__rw__:${filePath.length}:${filePath}:0:`);
            }
            break;
          }
          case ">&": {
            // Duplicate output FD: N>&M means N now writes to same place as M
            // Move FD: N>&M- means duplicate M to N, then close M
            if (target === "-") {
              // Close the FD
              fds?.delete(fd);
            } else if (target.endsWith("-")) {
              // Move operation: N>&M- duplicates M to N then closes M
              // Net-neutral on FD count (set + delete), skip checkFdLimit
              const sourceFdStr = target.slice(0, -1);
              const sourceFd = Number.parseInt(sourceFdStr, 10);
              if (!Number.isNaN(sourceFd)) {
                // First, duplicate: copy the FD content/info from source to target
                const sourceInfo = fds?.get(sourceFd);
                if (sourceInfo !== undefined) {
                  fds?.set(fd, sourceInfo!);
                } else {
                  // Source FD might be 1 (stdout) or 2 (stderr) which aren't in fileDescriptors
                  // In that case, store as duplication marker
                  fds?.set(fd, `__dupout__:${sourceFd}`);
                }
                // Then close the source FD
                fds?.delete(sourceFd);
              }
            } else {
              const sourceFd = Number.parseInt(target, 10);
              if (!Number.isNaN(sourceFd)) {
                // Store FD duplication: fd N points to fd M
                checkFdLimit(this.ctx);
                fds?.set(fd, `__dupout__:${sourceFd}`);
              }
            }
            break;
          }
          case "<&": {
            // Duplicate input FD: N<&M means N now reads from same place as M
            // Move FD: N<&M- means duplicate M to N, then close M
            if (target === "-") {
              // Close the FD
              fds?.delete(fd);
            } else if (target.endsWith("-")) {
              // Move operation: N<&M- duplicates M to N then closes M
              // Net-neutral on FD count (set + delete), skip checkFdLimit
              const sourceFdStr = target.slice(0, -1);
              const sourceFd = Number.parseInt(sourceFdStr, 10);
              if (!Number.isNaN(sourceFd)) {
                // First, duplicate: copy the FD content/info from source to target
                const sourceInfo = fds?.get(sourceFd);
                if (sourceInfo !== undefined) {
                  fds?.set(fd, sourceInfo!);
                } else {
                  // Source FD might be 0 (stdin) which isn't in fileDescriptors
                  fds?.set(fd, `__dupin__:${sourceFd}`);
                }
                // Then close the source FD
                fds?.delete(sourceFd);
              }
            } else {
              const sourceFd = Number.parseInt(target, 10);
              if (!Number.isNaN(sourceFd)) {
                // Store FD duplication for input
                checkFdLimit(this.ctx);
                this.ctx.state.fileDescriptors?.set(
                  fd,
                  `__dupin__:${sourceFd}`,
                );
              }
            }
            break;
          }
        }
      }
      // In bash, "exec" with only redirections does NOT persist prefix assignments
      // This is the "special case of the special case" - unlike other special builtins
      // (like ":"), exec without a command restores temp assignments
      for (const [name, value] of tempAssignments) {
        if (value === undefined) this.ctx.state.env.delete(name);
        else this.ctx.state.env.set(name, value as string);
      }
      // Clear temp exported vars
      const tempExportedVars = this.ctx.state.tempExportedVars;
      if (tempExportedVars) {
        for (const name of tempAssignments.keys()) {
          (tempExportedVars as Set<string>).delete(name);
        }
        this.ctx.state.exportedEnvDirty = true;
      }
      return OK;
    }

    // Generate xtrace output before running the command
    const xtraceOutput = await traceSimpleCommand(this.ctx, commandName, args);

    // Push tempEnvBindings onto the stack so unset can see them
    // This allows `unset v` to reveal the underlying global value when
    // v was set by a prefix assignment like `v=tempenv cmd`
    if (tempAssignments.size > 0) {
      const bindings = this.ctx.state.tempEnvBindings || [];
      bindings.push(new Map(tempAssignments));
      this.ctx.state.tempEnvBindings = bindings;
    }

    let cmdResult: ExecResult;
    let controlFlowError: BreakError | ContinueError | null = null;

    try {
      cmdResult = await this.runCommand(
        commandName,
        args,
        quotedArgs,
        stdin,
        false,
        false,
        stdinSourceFd,
      );
    } catch (error) {
      // For break/continue, we still need to apply redirections before propagating
      // This handles cases like "break > file" where the file should be created
      if (error instanceof BreakError || error instanceof ContinueError) {
        controlFlowError = error as BreakError | ContinueError;
        cmdResult = OK; // break/continue have exit status 0
      } else {
        throw error;
      }
    }

    // Prepend xtrace output and any assignment warnings to stderr
    const stderrPrefix = xtraceAssignmentOutput + xtraceOutput;
    if (stderrPrefix) {
      cmdResult = prependStderr(cmdResult, stderrPrefix);
    }

    // If agentic behavior is enabled and the command failed, trigger healer
    if (
      this.ctx.agentic &&
      this.ctx.agenticHealer &&
      cmdResult.exitCode !== 0
    ) {
      const healer = this.ctx.agenticHealer as AgenticHealer;
      const fullCommand =
        commandName + (args.length > 0 ? ` ${args.join(" ")}` : "");

      // Active self-healing: attempt to correct and re-execute
      const execFn = async (cmd: string): Promise<ExecResult> => {
        return this.ctx.execFn(cmd, { cwd: this.ctx.state.cwd });
      };
      const healedResult = await healer.heal(fullCommand, cmdResult, execFn);
      if (healedResult) {
        cmdResult = healedResult as ExecResult;
      } else {
        // Fall back to diagnostic suggestion (passive mode)
        const suggestion = await healer.diagnose(
          fullCommand,
          cmdResult,
          this.ctx,
        );
        if (suggestion) {
          cmdResult.stderr += `\n[Agentic Healer] ${suggestion}\n`;
        }
      }
    }

    cmdResult = await applyRedirections(this.ctx, cmdResult, node.redirections);

    // If we caught a break/continue error, re-throw it after applying redirections
    if (controlFlowError) {
      throw controlFlowError;
    }

    if (args.length > 0) {
      let lastArg = args[args.length - 1];
      // Special case for assignments in builtins
      if (
        (commandName === "declare" ||
          commandName === "local" ||
          commandName === "typeset") &&
        lastArg.includes("=(")
      ) {
        lastArg = lastArg.split("=")[0];
      }
      this.ctx.state.env.set("_", lastArg);
    } else {
      this.ctx.state.env.set("_", commandName);
    }

    // In POSIX mode, prefix assignments persist after special builtins
    // e.g., `foo=bar :` leaves foo=bar in the environment
    // Exception: `unset` and `eval` - bash doesn't apply POSIX temp binding persistence
    // for these builtins when they modify the same variable as the temp binding
    // In non-POSIX mode (bash default), temp assignments are always restored
    const isPosixSpecialWithPersistence =
      isPosixSpecialBuiltin(commandName) &&
      commandName !== "unset" &&
      commandName !== "eval";
    const shouldRestoreTempAssignments =
      !this.ctx.state.options.posix || !isPosixSpecialWithPersistence;

    if (shouldRestoreTempAssignments) {
      for (const [name, value] of tempAssignments) {
        // Skip restoration if this variable was a local that was fully unset
        // This implements bash's behavior where unsetting all local cells
        // prevents the tempenv from being restored
        if (this.ctx.state.fullyUnsetLocals?.has(name)) {
          continue;
        }
        if (value === undefined) this.ctx.state.env.delete(name);
        else this.ctx.state.env.set(name, value as string);
      }
    }

    // Clear temp exported vars after command execution
    const tempExportedVarsFinal = this.ctx.state.tempExportedVars;
    if (tempExportedVarsFinal) {
      for (const name of tempAssignments.keys()) {
        (tempExportedVarsFinal as Set<string>).delete(name);
      }
      this.ctx.state.exportedEnvDirty = true;
    }

    // Pop tempEnvBindings from the stack
    const bindingsFinal = this.ctx.state.tempEnvBindings;
    if (tempAssignments.size > 0 && bindingsFinal) {
      (bindingsFinal as any[]).pop();
    }

    // Include any stderr from expansion errors
    if (this.ctx.state.expansionStderr) {
      cmdResult = prependStderr(
        cmdResult,
        this.ctx.state.expansionStderr as string,
      );
      this.ctx.state.expansionStderr = "";
    }

    return cmdResult;
  }

  private async runCommand(
    commandName: string,
    args: string[],
    quotedArgs: boolean[],
    stdin: string,
    skipFunctions = false,
    useDefaultPath = false,
    stdinSourceFd = -1,
  ): Promise<ExecResult> {
    const dispatchCtx: BuiltinDispatchContext = {
      ctx: this.ctx,
      runCommand: (name, a, qa, s, sf, udp, ssf) =>
        this.runCommand(name, a, qa, s, sf, udp, ssf),
      buildExportedEnv: () => this.buildExportedEnv(),
      executeUserScript: (path, a, s) => this.executeUserScript(path, a, s),
    };

    // Try builtin dispatch first
    const builtinResult = await dispatchBuiltin(
      dispatchCtx,
      commandName,
      args,
      quotedArgs,
      stdin,
      skipFunctions,
      useDefaultPath,
      stdinSourceFd,
    );

    if (builtinResult !== null) {
      return builtinResult;
    }

    // Handle external command
    return executeExternalCommand(
      dispatchCtx,
      commandName,
      args,
      stdin,
      useDefaultPath,
    );
  }

  // Alias expansion state
  private aliasExpansionStack: Set<string> = new Set();

  private expandAlias(node: SimpleCommandNode): SimpleCommandNode {
    return expandAliasHelper(this.ctx.state, node, this.aliasExpansionStack);
  }

  async findCommandInPath(commandName: string): Promise<string[]> {
    return findCommandInPathHelper(this.ctx, commandName);
  }

  private async executeSubshell(
    node: SubshellNode,
    stdin = "",
  ): Promise<ExecResult> {
    return executeSubshellHelper(this.ctx, node, stdin, (stmt) =>
      this.executeStatement(stmt),
    );
  }

  private async executeGroup(node: GroupNode, stdin = ""): Promise<ExecResult> {
    return executeGroupHelper(this.ctx, node, stdin, (stmt) =>
      this.executeStatement(stmt),
    );
  }

  private async executeArithmeticCommand(
    node: ArithmeticCommandNode,
  ): Promise<ExecResult> {
    // Update currentLine for $LINENO
    if (node.line !== undefined) {
      this.ctx.state.currentLine = node.line;
    }

    // Pre-open output redirects to truncate files BEFORE evaluating expression
    // This matches bash behavior where redirect files are opened before
    // any command substitutions in the arithmetic expression are evaluated
    const preOpenError = await preOpenOutputRedirects(
      this.ctx,
      node.redirections,
    );
    if (preOpenError) {
      return preOpenError;
    }

    try {
      const arithResult = await evaluateArithmetic(
        this.ctx,
        node.expression.expression,
      );
      // Apply output redirections
      let bodyResult = testResult(arithResult !== 0);
      // Include any stderr from expansion (e.g., command substitution stderr)
      const arithExpErr = this.ctx.state.expansionStderr;
      if (arithExpErr) {
        bodyResult = prependStderr(bodyResult, arithExpErr);
        this.ctx.state.expansionStderr = "";
      }
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    } catch (error) {
      // Apply output redirections before returning
      const bodyResult = failure(
        `bash: arithmetic expression: ${(error as Error).message}\n`,
      );
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    }
  }

  private async executeConditionalCommand(
    node: ConditionalCommandNode,
  ): Promise<ExecResult> {
    // Update currentLine for error messages
    if (node.line !== undefined) {
      this.ctx.state.currentLine = node.line;
    }

    // Pre-open output redirects to truncate files BEFORE evaluating expression
    // This matches bash behavior where redirect files are opened before
    // any command substitutions in the conditional expression are evaluated
    const preOpenError = await preOpenOutputRedirects(
      this.ctx,
      node.redirections,
    );
    if (preOpenError) {
      return preOpenError;
    }

    try {
      const condResult = await evaluateConditional(this.ctx, node.expression);
      // Apply output redirections
      let bodyResult = testResult(condResult);
      // Include any stderr from expansion (e.g., bad array subscript warnings)
      const condExpErr = this.ctx.state.expansionStderr;
      if (condExpErr) {
        bodyResult = prependStderr(bodyResult, condExpErr);
        this.ctx.state.expansionStderr = "";
      }
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    } catch (error) {
      // Apply output redirections before returning
      // ArithmeticError (e.g., division by zero) returns exit code 1
      // Other errors (e.g., invalid regex) return exit code 2
      const exitCode = error instanceof ArithmeticError ? 1 : 2;
      const bodyResult = failure(
        `bash: conditional expression: ${(error as Error).message}\n`,
        exitCode,
      );
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    }
  }
}
