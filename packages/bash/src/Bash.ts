/**
 * Bash - Bash Shell Environment
 *
 * A complete bash-like shell environment using a proper AST-based architecture:
 *   Input → Parser → AST → Interpreter → Output
 *
 * This class provides the shell environment (filesystem, commands, variables)
 * and delegates execution to the Interpreter.
 */

import type { FunctionDefNode, ScriptNode } from "./ast/types.js";
// Eagerly import timers to capture references before defense-in-depth patches them
import "./timers.js";
import { EventEmitter } from "node:events";
import { AgenticHealer } from "./agentic/agentic-healer.js";
import { BashToolbox } from "./agentic/BashToolbox.js";
import type { AgenticHealerConfig } from "./agentic/types.js";
import {
  type CommandName,
  createJavaScriptCommands,
  createLazyCommands,
  createNetworkCommands,
  createPythonCommands,
} from "./commands/registry.js";
import {
  type CustomCommand,
  createLazyCustomCommand,
  isLazyCommand,
} from "./custom-commands.js";
import type { DestructivePolicy } from "./execution/index.js";
import {
  DestructiveStage,
  ExecutionPipeline,
  InterpretStage,
  NormalizeStage,
  ParseStage,
  PersistStage,
  SandboxStage,
  TransformStage,
} from "./execution/index.js";
import { InMemoryFs } from "./fs/in-memory-fs/in-memory-fs.js";
import { initFilesystem } from "./fs/init.js";
import type {
  FileSystemSnapshot,
  IFileSystem,
  InitialFiles,
} from "./fs/interface.js";
import { MountableFs } from "./fs/mountable-fs/index.js";
import {
  mapToRecord,
  mapToRecordWithExtras,
  mergeToNullPrototype,
} from "./helpers/env.js";
import { ExecutionLimitError } from "./interpreter/errors.js";
import {
  buildBashopts,
  buildShellopts,
} from "./interpreter/helpers/shellopts.js";
import type { DebuggerBridge, InterpreterState } from "./interpreter/index.js";
import { type ExecutionLimits, resolveLimits } from "./limits.js";
import type { LSPManager } from "./lsp/LSPManager.js";
import { SemanticEngine } from "./lsp/semantic-engine.js";
import { WorkspaceIndexer } from "./lsp/WorkspaceIndexer.js";
import {
  createSecureFetch,
  type NetworkConfig,
  type SecureFetch,
} from "./network/index.js";
import { AgTrace } from "./observability/ag-trace.js";
import { AgBashTracer } from "./observability/otel.js";
import type { OtelConfig } from "./observability/otel-types.js";
import { parse } from "./parser/parser.js";
import { DefenseInDepthBox } from "./security/defense-in-depth-box.js";
import type { DefenseInDepthConfig } from "./security/types.js";
import { PermissionManager } from "./services/PermissionManager.js";
import type { ServiceContainer } from "./services/ServiceContainer.js";
import { createDefaultServices } from "./services/ServiceContainer.js";
import {
  applyStateDelta,
  type BashDelta,
  diffFs,
  diffState,
} from "./state-sync/index.js";
import { StreamingExecutor } from "./streaming/StreamingExecutor.js";
import type { OutputChunk, StreamExecOptions } from "./streaming/types.js";
import { serialize } from "./transform/serialize.js";
import type {
  BashTransformResult,
  TransformPlugin,
} from "./transform/types.js";
import type {
  BashExecResult,
  Command,
  CommandRegistry,
  ExecResult,
  FeatureCoverageWriter,
  OutputSink,
  TraceCallback,
} from "./types.js";

/**
 * Metadata for tracking file state to detect staleness and provide suggestions.
 */
export interface FileState {
  content: string;
  timestamp: number;
  offset?: number;
  limit?: number;
  isPartialView?: boolean;
}

export type BashMode = "execute" | "plan";

export type { ExecutionLimits } from "./limits.js";

/**
 * Logger interface for Bash execution logging.
 * Implement this interface to receive execution logs.
 */
export interface BashLogger {
  /** Log informational messages (exec commands, stderr, exit codes) */
  info(message: string, data?: Record<string, unknown>): void;
  /** Log debug messages (stdout output) */
  debug(message: string, data?: Record<string, unknown>): void;
}

export interface JavaScriptConfig {
  /** Bootstrap JavaScript code to run before user scripts */
  bootstrap?: string;
}

/**
 * Interface for interactive permission approval.
 */
export interface PermissionHandler {
  /**
   * Ask the user for permission.
   * Returns true if granted, false otherwise.
   */
  ask(message: string): Promise<boolean>;
}

/**
 * Configuration for creating a Bash shell instance.
 *
 * @example
 * ```ts
 * const bash = new Bash({
 *   cwd: "/project",
 *   files: { "/project/hello.sh": "echo hello" },
 *   executionLimits: { maxOutputSize: 1024 * 1024 },
 * });
 * ```
 */
export interface BashOptions {
  /** Initial files to populate the virtual filesystem with. */
  files?: InitialFiles;
  /** Environment variables available to scripts (merged with defaults). */
  env?: Record<string, string>;
  /** Initial working directory. Defaults to "/". */
  cwd?: string;
  /** Custom filesystem implementation. Defaults to an in-memory FS. */
  fs?: IFileSystem;
  /** Which built-in command sets to register (e.g., "grep", "jq"). */
  commands?: CommandName[];
  /** User-defined commands added to the shell. */
  customCommands?: CustomCommand[];
  /** Resource limits (output size, execution time, recursion depth). */
  executionLimits?: ExecutionLimits;
  persistState?: boolean;
  sleep?: (ms: number) => Promise<void>;
  onCommandNotFound?: (
    command: string,
    args: string[],
  ) => Promise<ExecResult | null>;

  // Persistence
  persistence?: {
    root: string;
    mountPoint?: string;
  };

  /** WASM-based language runtimes (Python via CPython, JS via QuickJS). */
  runtimes?: {
    python?: boolean;
    javascript?: boolean | JavaScriptConfig;
  };

  /** Network access control: allowlists, transforms, and fetch overrides. */
  network?: NetworkConfig;
  fetch?: SecureFetch;

  /** Sandbox security hardening (defense-in-depth, process identity spoofing). */
  security?: {
    defenseInDepth?: DefenseInDepthConfig | boolean;
    processInfo?: {
      pid?: number;
      ppid?: number;
      uid?: number;
      gid?: number;
    };
  };

  /** AI agent integration: auto-healing, permission prompts, nesting control. */
  agentic?: {
    enabled?: boolean;
    healer?: AgenticHealerConfig;
    permissionHandler?: PermissionHandler;
    nestingDepth?: number;
  };

  // Parser
  parser?: {
    engine?: "legacy" | "tree-sitter";
    treeSitterConfig?: {
      webTreeSitterWasm: string | Uint8Array;
      bashGrammarWasm?: string | Uint8Array;
      grammars?: Record<string, string | Uint8Array>;
    };
  };

  // Debug & Observability
  debug?: {
    logger?: BashLogger;
    trace?: TraceCallback;
    coverage?: FeatureCoverageWriter;
    debugger?: DebuggerBridge;
    semanticEngine?: SemanticEngine;
  };

  /** Override default service implementations (dependency injection). */
  services?: Partial<ServiceContainer>;

  /**
   * Optional OpenTelemetry configuration for exec-level tracing.
   * When provided, an AgBashTracer is initialized and wraps each exec() call
   * in a span. If @opentelemetry/api is not installed, the tracer is a no-op
   * with zero overhead.
   */
  otel?: OtelConfig;

  /**
   * Default execution engine for exec() calls that do not specify execMode.
   * - "pipeline" (default, v6.0.0): the composable ExecutionPipeline.
   * - "monolith": preserved for backward type compatibility but now routes
   *   through the pipeline (the inline monolith code was removed in v6.0.0).
   * Defaults to "pipeline". Per-call `ExecOptions.execMode` overrides this.
   */
  execMode?: "monolith" | "pipeline";

  /**
   * Default policy for the AST-based destructive-command gate (E2). The gate is
   * a pipeline stage that runs after parse / before interpret and analyzes the
   * parsed AST so obfuscations (command substitution, $IFS, fork bombs,
   * decode-pipe-to-shell) are caught structurally.
   * - "warn" (DEFAULT): attach a typed Observation + stderr warning, then STILL
   *   execute (non-blocking — never breaks commands that ran before).
   * - "block": short-circuit with a non-zero result WITHOUT interpreting.
   * - "prompt": no in-process interactive prompt; falls back to block + a note.
   * - "allow": disable the gate.
   * Per-call `ExecOptions.destructivePolicy` overrides this.
   */
  destructivePolicy?: DestructivePolicy;
}

// v3.0 Breaking Changes:
// - options.python -> options.runtimes?.python
// - options.javascript -> options.runtimes?.javascript
// - options.logger -> options.debug?.logger
// - options.trace -> options.debug?.trace
// - options.coverage -> options.debug?.coverage
// - options.debugger -> options.debug?.debugger
// - options.semanticEngine -> options.debug?.semanticEngine
// - options.defenseInDepth -> options.security?.defenseInDepth
// - options.processInfo -> options.security?.processInfo
// - options.parserEngine -> options.parser?.engine
// - options.treeSitterConfig -> options.parser?.treeSitterConfig
// - options.agentic (boolean) -> options.agentic?.enabled
// - options.healer -> options.agentic?.healer
// - options.agenticConfig -> options.agentic?.healer
// - options.permissionHandler -> options.agentic?.permissionHandler
// - options.nestingDepth -> options.agentic?.nestingDepth

export interface ExecOptions {
  /**
   * Environment variables to set for this execution only.
   * These are merged with the current environment and restored after execution.
   */
  env?: Record<string, string>;
  /**
   * If true, start execution with an empty environment and then apply `env`.
   * If false/omitted, `env` is merged into the current environment.
   */
  replaceEnv?: boolean;
  /**
   * Working directory for this execution only.
   * Restored to original after execution.
   */
  cwd?: string;
  /**
   * If true, skip normalizing the script (trimming leading whitespace from lines).
   * Useful when running scripts where leading whitespace is significant (e.g., here-docs).
   * Default: false
   */
  rawScript?: boolean;
  /**
   * Standard input to pass to the script.
   * This will be available to commands via stdin (e.g., for `bash -c 'cat'`).
   */
  stdin?: string;
  /**
   * Abort signal for cooperative cancellation.
   * When aborted, the interpreter stops executing at the next statement boundary.
   */
  signal?: AbortSignal;
  /**
   * Additional argv entries appended to the first executed command at the interpreter level.
   * Values bypass shell parsing entirely — no escaping, splitting, or globbing.
   * Like child_process.spawnSync(cmd, args). These do not set or modify the shell's
   * positional parameters ($1, $2, "$@", etc.).
   */
  args?: string[];
  /**
   * If true, commit execution state back to the Bash instance after success.
   * Persists CWD, environment variables, and functions.
   */
  persistState?: boolean;
  /**
   * Optional debugger for statement-level control (specific to this call).
   */
  debugger?: DebuggerBridge;
  /**
   * Optional semantic engine for AST analysis (specific to this call).
   */
  semanticEngine?: SemanticEngine;
  /**
   * Optional agentic healer (specific to this call).
   */
  agenticHealer?: AgenticHealer;
  /**
   * Optional session ID for stateful REPLs (js-exec, python3).
   */
  sessionId?: string;
  /**
   * Execution engine to use for this call.
   * - "pipeline" (default, v6.0.0): the composable ExecutionPipeline.
   * - "monolith": preserved for backward type compatibility but now routes
   *   through the pipeline (the inline monolith code was removed in v6.0.0).
   * Overrides the instance-level `defaultExecMode`.
   */
  execMode?: "monolith" | "pipeline";
  /**
   * Per-call override for the AST-based destructive-command gate (E2).
   * - "warn" (default): attach an Observation + stderr warning but STILL execute.
   * - "block": short-circuit with a non-zero result without interpreting.
   * - "prompt": no in-process interactive prompt, so falls back to block.
   * - "allow": disable the gate for this call.
   * Overrides the instance-level `BashOptions.destructivePolicy`.
   */
  destructivePolicy?: DestructivePolicy;
  /**
   * Opt-in incremental output sink (true streaming). When provided, the
   * interpreter invokes it with stdout/stderr fragments as statements produce
   * them, preserving order. When OMITTED, exec() is byte-identical to the
   * buffered path with zero measurable overhead — the sink is never created or
   * invoked. Primarily used by {@link StreamingExecutor} / {@link Bash.execStream}.
   */
  onChunk?: OutputSink;
}

/**
 * A sandboxed bash shell with a virtual filesystem, built-in commands, and
 * optional WASM runtimes. Safe to run untrusted scripts — all I/O stays in-memory.
 *
 * @example
 * ```ts
 * import { Bash } from "@ag-bash/bash";
 *
 * const bash = new Bash({ cwd: "/app", files: { "/app/data.txt": "hello" } });
 * const result = await bash.exec("cat /app/data.txt | wc -c");
 * console.log(result.stdout); // "6\n"
 * ```
 */
export class Bash extends EventEmitter {
  readonly fs: MountableFs;
  private commands: CommandRegistry = new Map();
  private useDefaultLayout: boolean = false;
  public readonly limits: Required<ExecutionLimits>;
  private secureFetch?: SecureFetch;
  private sleepFn?: (ms: number) => Promise<void>;

  /**
   * Tracks the state of files read or written during the session.
   * Key is the absolute path to the file.
   */
  public readonly fileState: Map<string, FileState> = new Map<
    string,
    FileState
  >();

  /**
   * Creates a new Bash shell instance.
   */
  private traceFn?: TraceCallback;
  private logger?: BashLogger;
  private defenseInDepthConfig?: DefenseInDepthConfig | boolean;
  private coverageWriter?: FeatureCoverageWriter;
  private jsBootstrapCode?: string;
  private onCommandNotFound?: BashOptions["onCommandNotFound"];
  // biome-ignore lint/suspicious/noExplicitAny: type-erased plugin storage for untyped API
  private transformPlugins: TransformPlugin<any>[] = [];
  private defaultPersistState: boolean;
  private readonly otelTracer?: AgBashTracer;
  private readonly defaultExecMode: "monolith" | "pipeline";
  /**
   * Instance-level default policy for the AST destructive-command gate (E2).
   * Defaults to "warn" (non-blocking). Per-call `ExecOptions.destructivePolicy`
   * overrides this inside the DestructiveStage.
   */
  private readonly defaultDestructivePolicy: DestructivePolicy;
  /** Lazily-built pipeline for the "pipeline" execMode (cached per instance). */
  private executionPipeline?: ExecutionPipeline;
  /** Lazily-built streaming executor for execStream() (cached per instance). */
  private streamingExecutor?: StreamingExecutor;
  private parserEngine: "legacy" | "tree-sitter";
  private treeSitterConfig?: NonNullable<
    BashOptions["parser"]
  >["treeSitterConfig"];
  private agentic: boolean;
  private debugger?: DebuggerBridge;
  public semanticEngine: SemanticEngine;
  public indexer: WorkspaceIndexer;
  private agenticHealer?: AgenticHealer;
  public toolbox: BashToolbox;
  public permissionManager: PermissionManager;
  public readonly nestingDepth: number;
  public readonly services: ServiceContainer;

  // Interpreter state (shared with interpreter instances)
  private state: InterpreterState;
  private snapshots: Map<string, BashSnapshot> = new Map();
  public readonly options: BashOptions;

  constructor(options: BashOptions = {}) {
    super();
    this.options = options;
    this.nestingDepth = options.agentic?.nestingDepth ?? 0;
    this.services = createDefaultServices(options.services, () => this.fs);
    this.permissionManager = new PermissionManager(
      options.agentic?.permissionHandler,
    );
    this.toolbox = new BashToolbox();
    this.initLsp();
    this.fs =
      options.fs instanceof MountableFs
        ? options.fs
        : new MountableFs({
            base: options.fs ?? new InMemoryFs(options.files),
          });

    const fs = this.fs;

    // Handle auto-persistence
    if (options.persistence) {
      this.usePersistence(
        options.persistence.root,
        options.persistence.mountPoint || "/home/user",
      );
    }

    this.useDefaultLayout = !options.cwd && !options.files;
    const cwd = options.cwd || (this.useDefaultLayout ? "/home/user" : "/");
    // Use Map for env to prevent prototype pollution attacks
    const env = new Map<string, string>([
      ["HOME", this.useDefaultLayout ? "/home/user" : "/"],
      ["PATH", "/usr/bin:/bin"],
      ["IFS", " \t\n"],
      ["OSTYPE", "linux-gnu"],
      ["MACHTYPE", "x86_64-pc-linux-gnu"],
      ["HOSTTYPE", "x86_64"],
      ["HOSTNAME", "localhost"], // Match hostname command in sandboxed environment
      ["PWD", cwd],
      ["OLDPWD", cwd],
      ["OPTIND", "1"], // getopts option index
      // Add user-provided env vars
      ...Object.entries(options.env ?? {}),
    ]);

    this.limits = resolveLimits(options.executionLimits);

    this.services.astCache.configure({
      maxEntries: this.limits.astCacheSize,
    });

    // Create secure fetch: prefer explicit fetch, fall back to network config
    if (options.fetch) {
      this.secureFetch = options.fetch;
    } else if (options.network) {
      this.secureFetch = createSecureFetch({
        ...options.network,
        onTraffic: (bytes) => {
          this.state.networkTrafficBytes += bytes;
        },
      });
    }

    // Store sleep function if provided (for mock clocks in testing)
    this.sleepFn = options.sleep;

    // Store trace callback if provided (for performance profiling)
    this.traceFn = options.debug?.trace;

    // Store logger if provided
    this.logger = options.debug?.logger;

    // Store onCommandNotFound hook if provided
    this.onCommandNotFound = options.onCommandNotFound;

    // Defense-in-depth defaults to enabled
    this.defenseInDepthConfig = options.security?.defenseInDepth ?? true;

    // Agentic behavior defaults to false
    this.agentic = options.agentic?.enabled ?? false;

    // Store coverage writer if provided (for fuzzing instrumentation)
    this.coverageWriter = options.debug?.coverage;

    // Initialize interpreter state
    this.state = {
      env,
      cwd,
      previousDir: "/home/user",
      functions: new Map<string, FunctionDefNode>(),
      localScopes: [],
      callDepth: 0,
      sourceDepth: 0,
      commandCount: 0,
      lastExitCode: 0,
      lastArg: "", // $_ is initially empty (or could be shell name)
      startTime: Date.now(),
      executionStartTime: Date.now(),
      networkTrafficBytes: 0,
      mcpToolCallCount: 0,
      lastBackgroundPid: 0,
      virtualPid: options.security?.processInfo?.pid ?? 1,
      virtualPpid: options.security?.processInfo?.ppid ?? 0,
      virtualUid: options.security?.processInfo?.uid ?? 1000,
      virtualGid: options.security?.processInfo?.gid ?? 1000,
      bashPid: options.security?.processInfo?.pid ?? 1, // BASHPID starts as virtual PID
      nextVirtualPid: (options.security?.processInfo?.pid ?? 1) + 1, // Counter for unique subshell PIDs
      currentLine: 1, // $LINENO starts at 1
      options: {
        errexit: false,
        pipefail: false,
        nounset: false,
        xtrace: false,
        verbose: false,
        posix: false,
        allexport: false,
        noclobber: false,
        noglob: false,
        noexec: false,
        vi: false,
        emacs: false,
      },
      shoptOptions: {
        extglob: false,
        dotglob: false,
        nullglob: false,
        failglob: false,
        globstar: false,
        globskipdots: true, // Default to true in bash >=5.2
        nocaseglob: false,
        nocasematch: false,
        expand_aliases: false,
        lastpipe: false,
        xpg_echo: false,
      },
      inCondition: false,
      loopDepth: 0,
      // Export standard shell variables by default (matches bash behavior)
      // These variables are typically inherited from the parent shell environment
      exportedVars: new Set([
        "HOME",
        "PATH",
        "PWD",
        "OLDPWD",
        // Also export any user-provided environment variables
        ...Object.keys(options.env || {}),
      ]),
      // SHELLOPTS and BASHOPTS are readonly
      readonlyVars: new Set(["SHELLOPTS", "BASHOPTS"]),
      // Hash table for PATH command lookup caching
      hashTable: new Map(),
      mode: "execute",
    };

    // Initialize SHELLOPTS to reflect current shell options (initially empty string since all are false)
    this.state.env.set("SHELLOPTS", buildShellopts(this.state.options));
    // Initialize BASHOPTS to reflect current shopt options
    this.state.env.set("BASHOPTS", buildBashopts(this.state.shoptOptions));

    // Initialize filesystem with standard directories and device files
    // Only applies to InMemoryFs - other filesystems use real directories
    initFilesystem(fs, this.useDefaultLayout, {
      pid: this.state.virtualPid,
      ppid: this.state.virtualPpid,
      uid: this.state.virtualUid,
      gid: this.state.virtualGid,
    });

    if (cwd !== "/" && fs instanceof InMemoryFs) {
      try {
        fs.mkdirSync(cwd, { recursive: true });
      } catch {
        // Ignore errors
      }
    }

    for (const cmd of createLazyCommands(options.commands)) {
      this.registerCommand(cmd);
    }

    // Register network commands when fetch or network is configured
    if (options.fetch || options.network) {
      for (const cmd of createNetworkCommands()) {
        this.registerCommand(cmd);
      }
    }

    // Register python commands only when explicitly enabled
    // Python introduces additional security surface (arbitrary code execution)
    if (options.runtimes?.python) {
      for (const cmd of createPythonCommands()) {
        this.registerCommand(cmd);
      }
    }

    // Register javascript commands only when explicitly enabled
    if (options.runtimes?.javascript) {
      for (const cmd of createJavaScriptCommands()) {
        this.registerCommand(cmd);
      }
      // Store bootstrap code in private field (threaded via context chain, not env)
      const jsConfig =
        typeof options.runtimes.javascript === "object"
          ? options.runtimes.javascript
          : Object.create(null);
      if (jsConfig.bootstrap) {
        this.jsBootstrapCode = jsConfig.bootstrap;
      }
    }

    // Register custom commands (after built-ins so they can override)
    if (options.customCommands) {
      for (const cmd of options.customCommands) {
        if (isLazyCommand(cmd)) {
          this.registerCommand(createLazyCustomCommand(cmd));
        } else {
          this.registerCommand({
            ...cmd,
            trusted: cmd.trusted ?? true,
          });
        }
      }
    }

    this.defaultPersistState = options.persistState ?? false;
    // Execution engine (v6.0.0): the composable ExecutionPipeline is now the
    // default live path — proven byte-equivalent to the legacy monolith across
    // the full test suite (identical results, with one nested-cancellation case
    // the pipeline handles correctly). The monolith remains available as an
    // opt-in fallback via execMode:"monolith" (or AG_BASH_EXEC_MODE=monolith)
    // and will be removed in a later release.
    const envExecMode =
      typeof process !== "undefined" &&
      (process.env?.AG_BASH_EXEC_MODE === "monolith" ||
        process.env?.AG_BASH_EXEC_MODE === "pipeline")
        ? (process.env.AG_BASH_EXEC_MODE as "monolith" | "pipeline")
        : undefined;
    this.defaultExecMode = options.execMode ?? envExecMode ?? "pipeline";
    this.defaultDestructivePolicy = options.destructivePolicy ?? "warn";
    this.parserEngine = options.parser?.engine ?? "legacy";
    this.treeSitterConfig = options.parser?.treeSitterConfig;
    this.debugger = options.debug?.debugger;
    this.semanticEngine = options.debug?.semanticEngine ?? new SemanticEngine();
    this.indexer = new WorkspaceIndexer(this, this.semanticEngine);
    this.agentic = options.agentic?.enabled ?? false;
    if (this.agentic) {
      this.agenticHealer = new AgenticHealer(
        this.toolbox,
        options.agentic?.healer || { enableHeuristics: true },
      );
    }

    // Initialize OTel tracer if config is provided (no-op when @opentelemetry/api absent)
    if (options.otel) {
      this.otelTracer = new AgBashTracer(options.otel);
      // Fire-and-forget initialization — safe because the tracer is a no-op until init completes
      void this.otelTracer.initialize();
    }
  }

  /**
   * Close a persistent session and terminate its worker.
   */
  public async closeSession(sessionId: string): Promise<void> {
    await this.services.sessionManager.terminateSession(sessionId);
    if (this.state.sessionId === sessionId) {
      this.state.sessionId = undefined;
    }
  }

  /**
   * Sets the current mode of the shell (execute or plan).
   */
  public setMode(mode: BashMode): void {
    this.state.mode = mode;
    this.logger?.info("mode_change", { mode });
  }

  /**
   * Gets the current mode of the shell.
   */
  public getMode(): BashMode {
    return this.state.mode;
  }

  public get cwd(): string {
    return this.state.cwd;
  }

  public get env(): Record<string, string> {
    const res: Record<string, string> = Object.create(null);
    for (const [k, v] of this.state.env) {
      res[k] = v;
    }
    return res;
  }

  public get lsp(): LSPManager {
    return this.services.lspManager;
  }

  private async initLsp(): Promise<void> {
    const lsp = this.services.lspManager;
    // Initialize TS server if available
    await lsp.initServer("ts", "typescript-language-server", ["--stdio"]);
    await lsp.initServer("js", "typescript-language-server", ["--stdio"]);
  }

  /**
   * Updates the tracked state for a file.
   */
  public updateFileState(path: string, state: Partial<FileState>): void {
    const existing = this.fileState.get(path) || {
      content: "",
      timestamp: Date.now(),
    };
    this.fileState.set(path, {
      ...existing,
      ...state,
      timestamp: Date.now(),
    });
  }

  /**
   * Gets the tracked state for a file.
   */
  public getFileState(path: string): FileState | undefined {
    return this.fileState.get(path);
  }

  registerCommand(command: Command): void {
    this.commands.set(command.name, command);
    // Create command stubs in /bin and /usr/bin for PATH-based resolution
    // Works for both InMemoryFs and OverlayFs (both have writeFileSync)
    // Commands are registered to both locations like real Linux systems
    // (where /bin is often a symlink to /usr/bin on modern systems)
    const fs = this.fs as {
      writeFileSync?: (path: string, content: string) => void;
    };
    if (typeof fs.writeFileSync === "function") {
      const stub = `#!/bin/bash\n# Built-in command: ${command.name}\n`;
      try {
        fs.writeFileSync(`/bin/${command.name}`, stub);
      } catch {
        // Ignore errors
      }
      try {
        fs.writeFileSync(`/usr/bin/${command.name}`, stub);
      } catch {
        // Ignore errors
      }
    }
  }

  private logResult(result: BashExecResult): BashExecResult {
    if (this.logger) {
      if (result.stdout) {
        this.logger.debug("stdout", { output: result.stdout });
      }
      if (result.stderr) {
        this.logger.info("stderr", { output: result.stderr });
      }
      this.logger.info("exit", { exitCode: result.exitCode });
    }
    // Decode binary strings (latin1) to UTF-8 at the output boundary.
    // Internally, the pipeline uses binary strings where each char = one byte
    // for byte transparency. At the output boundary, we convert valid UTF-8
    // byte sequences back to proper Unicode characters (e.g., CJK, emoji).
    // Invalid UTF-8 (e.g., raw compressed data) is left as binary.
    result.stdout = decodeBinaryToUtf8(result.stdout);
    result.stderr = decodeBinaryToUtf8(result.stderr);
    if (result.observations && result.observations.length > 0) {
      this.logger?.info("observations", { observations: result.observations });
    }
    return result;
  }

  async exec(
    commandLine: string,
    options?: ExecOptions,
  ): Promise<BashExecResult> {
    if (this.state.callDepth === 0) {
      this.state.commandCount = 0;
    }

    this.state.commandCount++;
    if (this.state.commandCount > this.limits.maxCommandCount) {
      const error = new ExecutionLimitError(
        `bash: maximum command count (${this.limits.maxCommandCount}) exceeded (possible infinite loop). Increase with executionLimits.maxCommandCount option.\n`,
        "commands",
      );
      return this.logResult({
        stdout: "",
        stderr: error.message,
        exitCode: ExecutionLimitError.EXIT_CODE,
        env: mapToRecordWithExtras(this.state.env, options?.env),
        observations: [AgTrace.analyzeError(error)],
      });
    }

    if (!commandLine.trim()) {
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        env: mapToRecordWithExtras(this.state.env, options?.env),
      };
    }

    // Heredoc normalization (ensure delimiters are trimmed if not in raw mode)
    const normalizedCommandLine = options?.rawScript
      ? commandLine
      : commandLine.replace(
          /<<-?\s*["']?(\w+)["']?/g,
          (_match, delimiter) => `<<${delimiter}`,
        );

    // Log command execution
    this.logger?.info("exec", { command: normalizedCommandLine });

    // Each exec call gets an isolated state copy - like starting a new shell
    // This ensures exec calls never interfere with each other
    const effectiveCwd = options?.cwd ?? this.state.cwd;

    // Determine PWD and cwd for the new shell context
    // If PWD is in the provided env, use it (inherited from parent)
    // If PWD is NOT in the provided env (was unset), use realpath to get physical path
    // This matches bash behavior: when PWD is unset and a new shell starts,
    // it initializes PWD (and cwd) using realpath (resolving symlinks)
    let newPwd: string | undefined;
    let newCwd = effectiveCwd;
    if (options?.cwd) {
      if (options.env && "PWD" in options.env) {
        // PWD explicitly provided - use it
        newPwd = options.env.PWD;
      } else if (options?.env && !("PWD" in options.env)) {
        // PWD not in provided env - use realpath to resolve symlinks
        // This also updates cwd since the shell determines its position from scratch
        try {
          newPwd = await this.fs.realpath(effectiveCwd);
          newCwd = newPwd; // Both PWD and cwd should be the physical path
        } catch {
          // Fallback to logical path if realpath fails
          newPwd = effectiveCwd;
        }
      } else {
        // No env provided - use logical cwd
        newPwd = effectiveCwd;
      }
    }

    // Create environment for this execution
    const execEnv = options?.replaceEnv
      ? new Map<string, string>()
      : new Map(this.state.env);
    // Merge in options.env
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        execEnv.set(key, value);
      }
    }
    // Update PWD when cwd option is provided
    if (newPwd !== undefined) {
      execEnv.set("PWD", newPwd);
    }

    const execState: InterpreterState = {
      ...this.state,
      env: execEnv,
      cwd: newCwd,
      // Deep copy mutable objects to prevent interference
      functions: new Map(this.state.functions),
      localScopes: [...this.state.localScopes],
      options: { ...this.state.options },
      // Share hashTable reference - it should persist across exec calls
      hashTable: this.state.hashTable,
      // Pass stdin through to commands (for bash -c with piped input)
      groupStdin: options?.stdin,
      // Cooperative cancellation signal (used by timeout command)
      signal: options?.signal,
      // Extra arguments injected directly into first command's arg list
      extraArgs: options?.args,
      executionStartTime: Date.now(),
      sessionId: options?.sessionId ?? this.state.sessionId,
    };

    // Normalize indented multi-line scripts (unless rawScript is true)
    // This allows writing indented bash scripts in template literals
    // BUT we must preserve whitespace inside heredoc content
    let normalized = normalizedCommandLine;
    if (!options?.rawScript) {
      normalized = normalizeScript(normalizedCommandLine);
    }

    // Branch on execution engine. The instance-coupled prologue above
    // (command-count guard, empty short-circuit, heredoc normalization,
    // exec logging, PWD/realpath/cwd derivation, execEnv + execState build,
    // whitespace normalization) is SHARED by both engines and stays here so
    // that recursive execs (via the exec.bind hook) re-enter the same guard.
    const execMode = options?.execMode ?? this.defaultExecMode;
    if (execMode === "pipeline") {
      // Wrap in OTEL span when tracer is configured (zero-cost no-op otherwise)
      if (this.otelTracer) {
        const span = this.otelTracer.startExecSpan(commandLine);
        // Monotonic start mark for span duration. performance.now() is a
        // monotonic clock (immune to wall-clock jumps) and is NOT one of the
        // banned nondeterministic primitives (Date.now / new Date / Math.random).
        const spanStart = performance.now();
        try {
          const result = await this.execViaPipeline(
            commandLine,
            options,
            execState,
          );
          span.setAttribute("ag-bash.exitCode", result.exitCode);
          span.setAttribute(
            "ag-bash.durationMs",
            performance.now() - spanStart,
          );
          span.end();
          return result;
        } catch (spanError: unknown) {
          // Record the exception event BEFORE setting error status so the span
          // carries both the typed exception and the error code.
          span.recordException(spanError);
          span.setAttribute(
            "ag-bash.durationMs",
            performance.now() - spanStart,
          );
          span.setStatus({ code: 2, message: "exec failed" });
          span.end();
          throw spanError;
        }
      }
      return this.execViaPipeline(commandLine, options, execState);
    }

    // v6.0.0: The monolith code path has been removed. The ExecutionPipeline
    // is now the sole execution engine. If execMode is "monolith" (for backward
    // compat at the type level), it transparently falls through to the pipeline.
    return this.execViaPipeline(commandLine, options, execState);
  }

  /**
   * Build (and cache) the ExecutionPipeline used by the "pipeline" execMode.
   *
   * The stages mirror the monolithic Bash.exec() body exactly:
   *   normalize → parse → transform → sandbox → destructive → interpret → persist
   * with error categorization + UTF-8 decode/log applied by the pipeline
   * runner (via the finalize callback and its internal catch).
   *
   * Parity-critical wiring:
   * - requireDefenseContext is computed from the REAL DefenseInDepthBox's
   *   isEnabled() (NOT inferred from the handle), matching Bash.ts monolith.
   * - The finalize callback is this.logResult (decode binary→UTF-8 + log),
   *   applied to every result leaving the pipeline (success AND error).
   * - The persist callback performs the exact 7-field commit-back the monolith
   *   does (cwd/env/functions/hashTable by reference; shoptOptions/options via
   *   spread; lastExitCode), gated on exit 0 inside PersistStage.
   * - execFn = this.exec.bind(this) so recursive execs re-enter exec() and hit
   *   the command-count guard (which lives in exec(), before this branch).
   * - this.services is passed so astCache + sharedBus are SHARED, matching
   *   the monolith's this.services usage.
   */
  private buildExecutionPipeline(): ExecutionPipeline {
    const requireDefenseContext = this.defenseInDepthConfig
      ? DefenseInDepthBox.getInstance(this.defenseInDepthConfig).isEnabled() ===
        true
      : false;

    const pipeline = new ExecutionPipeline((result) => this.logResult(result));
    pipeline.addStage(new NormalizeStage());
    pipeline.addStage(
      new ParseStage({
        parserEngine: this.parserEngine,
        treeSitterConfig: this.treeSitterConfig,
        limits: this.limits,
      }),
    );
    pipeline.addStage(new TransformStage(this.transformPlugins));
    pipeline.addStage(new SandboxStage(this.defenseInDepthConfig));
    // E2 destructive-command gate (R1 wiring): runs AFTER parse/transform (it
    // analyzes the parsed AST) and BEFORE interpret (so BLOCK can short-circuit
    // without executing, and WARN can stash a typed observation that the
    // pipeline runner merges onto the interpreter result). The instance default
    // policy is "warn" (non-blocking); ExecOptions.destructivePolicy overrides
    // per-call inside the stage.
    pipeline.addStage(new DestructiveStage(this.defaultDestructivePolicy));
    pipeline.addStage(
      new InterpretStage({
        fs: this.fs,
        commands: this.commands,
        limits: this.limits,
        execFn: this.exec.bind(this),
        secureFetch: this.secureFetch,
        sleepFn: this.sleepFn,
        traceFn: this.traceFn,
        coverageWriter: this.coverageWriter,
        jsBootstrapCode: this.jsBootstrapCode,
        onCommandNotFound: this.onCommandNotFound,
        agentic: this.agentic,
        debugger: this.debugger,
        semanticEngine: this.semanticEngine,
        agenticHealer: this.agenticHealer,
        bash: this,
        requireDefenseContext,
      }),
    );
    pipeline.addStage(
      new PersistStage(this.defaultPersistState, (execState, exitCode) => {
        this.state.cwd = execState.cwd;
        this.state.env = execState.env;
        this.state.functions = execState.functions;
        this.state.lastExitCode = exitCode;
        this.state.shoptOptions = { ...execState.shoptOptions };
        this.state.options = { ...execState.options };
        this.state.hashTable = execState.hashTable;
      }),
    );
    return pipeline;
  }

  /**
   * Execute a script through the composable ExecutionPipeline.
   *
   * The instance-coupled prologue (command-count guard, empty short-circuit,
   * PWD/cwd derivation, execEnv + execState construction) has ALREADY run in
   * exec() before this is called; we receive the finished execState and pass
   * the RAW commandLine so NormalizeStage performs (idempotent) normalization,
   * keeping the pipeline self-contained for AST-cache keying.
   *
   * NOTE on requireDefenseContext caching: the pipeline computes it once at
   * build time from the singleton DefenseInDepthBox. The box's isEnabled() is a
   * pure function of its (config.enabled, AsyncLocalStorage availability), which
   * cannot change for a given Bash instance, so caching is safe and matches the
   * monolith's per-call recomputation.
   */
  private execViaPipeline(
    commandLine: string,
    options: ExecOptions | undefined,
    execState: InterpreterState,
  ): Promise<BashExecResult> {
    if (!this.executionPipeline) {
      this.executionPipeline = this.buildExecutionPipeline();
    }
    return this.executionPipeline.run(
      commandLine,
      options,
      this,
      this.services,
      execState,
      this.state,
    );
  }

  /**
   * Execute a script and stream its output INCREMENTALLY as commands produce
   * it, yielding {@link OutputChunk} objects via an AsyncGenerator.
   *
   * Unlike {@link exec} (which buffers everything and returns once), this emits
   * stdout/stderr fragments in production order as each statement runs, then a
   * final `exit` chunk carrying the exit code. The concatenation of streamed
   * stdout chunks is byte-identical to `(await exec(script)).stdout`.
   *
   * Implemented atop the opt-in {@link ExecOptions.onChunk} sink; buffered
   * exec() is unaffected when execStream is not used.
   *
   * @example
   * ```ts
   * for await (const chunk of bash.execStream("echo a; echo b")) {
   *   if (chunk.type === "stdout") process.stdout.write(chunk.data);
   * }
   * ```
   */
  execStream(
    script: string,
    options?: StreamExecOptions,
  ): AsyncGenerator<OutputChunk, void, undefined> {
    if (!this.streamingExecutor) {
      this.streamingExecutor = new StreamingExecutor(this);
    }
    return this.streamingExecutor.execStream(script, options);
  }

  /**
   * Create a snapshot of the current shell state, including filesystem changes.
   * Useful for "branching" execution in agentic workflows or reverting
   * to a known-good state after trial execution.
   */
  async snapshot(): Promise<BashSnapshot> {
    return {
      state: this.cloneState(this.state),
      fs: await this.fs.snapshot(),
    };
  }

  /**
   * Creates a differential delta between a base snapshot and current state.
   */
  async createDelta(base: BashSnapshot): Promise<BashDelta> {
    const current = await this.snapshot();
    const delta = diffState(base, current);
    delta.fsDelta = diffFs(base.fs, current.fs);
    return delta;
  }

  /**
   * Applies a differential delta to the current state.
   */
  async applyDelta(delta: BashDelta): Promise<void> {
    applyStateDelta(this.state, delta);
    if (delta.fsDelta) {
      for (const [path, content] of Object.entries(delta.fsDelta.modified)) {
        await this.fs.writeFile(path, content);
      }
      for (const path of delta.fsDelta.deleted) {
        try {
          await this.fs.rm(path);
        } catch {
          // Ignore if already deleted
        }
      }
    }
  }

  /**
   * Restores the shell to a previously captured snapshot.
   */
  async restore(snapshot: BashSnapshot): Promise<void> {
    this.state = this.cloneState(snapshot.state);
    await this.fs.restore(snapshot.fs);
  }

  /**
   * Save a named snapshot of the current state.
   */
  async saveSnapshot(name: string): Promise<void> {
    const snap = await this.snapshot();
    this.snapshots.set(name, snap);
  }

  /**
   * Restore a named snapshot.
   */
  async restoreSnapshot(name: string): Promise<void> {
    const snap = this.snapshots.get(name);
    if (!snap) {
      throw new Error(`Snapshot '${name}' not found`);
    }
    await this.restore(snap);
  }

  /**
   * Fork the sandbox into an independent copy-on-write branch.
   *
   * Returns a NEW {@link Bash} instance that, at the moment of the call, is an
   * exact copy of this one (env, cwd, functions, shell options, and the entire
   * virtual filesystem) but shares NOTHING mutable with the parent. The child
   * is independently executable; mutations in the child — environment changes,
   * `cd`, function (re)definitions, and filesystem writes — are invisible to
   * the parent, and parent mutations after the fork are invisible to the child.
   *
   * This is the core primitive for fork-speculation: an agent forks N branches,
   * runs candidate command sequences in parallel, then keeps the winner and
   * discards the rest (discarding is just dropping the child reference).
   *
   * Forking is cheap because the underlying snapshot deep-copies state and the
   * copy-on-write VFS only materializes mutated entries.
   *
   * Note: host-backed mounts (e.g. {@link usePersistence} via `ReadWriteFs`)
   * write through to the real filesystem and are therefore NOT isolated by the
   * fork — only the in-VFS layers are copy-on-write. Use an in-memory sandbox
   * for fully isolated speculation.
   *
   * @returns A new, fully isolated `Bash` branch.
   */
  async fork(): Promise<Bash> {
    const branch = new Bash(this.options);
    const snap = await this.snapshot();
    await branch.restore(snap);
    return branch;
  }

  /**
   * Speculatively run candidate branches in isolated forks and collect their
   * results, leaving this (parent) instance untouched.
   *
   * Each branch receives its own {@link fork} of the current sandbox and runs
   * concurrently. Results are returned in branch order so the caller can score
   * them and "keep the winner" (e.g. by re-applying the winning command on the
   * parent). Discarded branches require no cleanup — their references are simply
   * dropped.
   *
   * @typeParam T - The result type each branch produces.
   * @param branches - Candidate functions, each given an isolated child `Bash`.
   * @returns The branch results, in the same order as `branches`.
   */
  async speculate<T>(
    branches: Array<(branch: Bash) => Promise<T>>,
  ): Promise<T[]> {
    const forks = await Promise.all(branches.map(() => this.fork()));
    return Promise.all(branches.map((run, i) => run(forks[i])));
  }

  /**
   * Save the workspace symbol index to disk.
   */
  public async saveIndex(): Promise<void> {
    const indexData = this.semanticEngine.serialize();
    const dir = ".ag-bash";
    if (!(await this.fs.exists(dir))) {
      await this.fs.mkdir(dir, { recursive: true });
    }
    await this.fs.writeFile(`${dir}/index.json`, indexData);
  }

  /**
   * Load the workspace symbol index from disk.
   */
  public async loadIndex(): Promise<void> {
    const indexPath = ".ag-bash/index.json";
    if (await this.fs.exists(indexPath)) {
      const data = await this.fs.readFile(indexPath);
      this.semanticEngine.deserialize(data);
    }
  }

  /**
   * Mount a filesystem at the specified virtual path.
   */
  mount(mountPoint: string, filesystem: IFileSystem): void {
    this.fs.mount(mountPoint, filesystem);
  }

  /**
   * Configure persistent storage for a specific path.
   * In Node.js, this mounts a ReadWriteFs directly to the host filesystem.
   */
  async usePersistence(
    root: string,
    mountPoint: string = "/home/user",
  ): Promise<void> {
    // Dynamic import to stay isomorphic
    const { ReadWriteFs } = await import("./fs/read-write-fs/index.js");
    const persistentFs = new ReadWriteFs({ root });
    this.mount(mountPoint, persistentFs);
  }

  /**
   * Unmount the filesystem at the specified path.
   */
  unmount(mountPoint: string): void {
    this.fs.unmount(mountPoint);
  }

  /**
   * Deep-clone the interpreter state to ensure isolation.
   */
  private cloneState(state: InterpreterState): InterpreterState {
    return {
      ...state,
      env: new Map(state.env),
      functions: new Map(state.functions),
      localScopes: state.localScopes.map((s) => new Map(s)),
      options: { ...state.options },
      shoptOptions: { ...state.shoptOptions },
      exportedVars: new Set(state.exportedVars),
      readonlyVars: new Set(state.readonlyVars),
      hashTable: state.hashTable ? new Map(state.hashTable) : undefined,
    };
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  async readFile(path: string): Promise<string> {
    return this.fs.readFile(this.fs.resolvePath(this.state.cwd, path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.fs.writeFile(
      this.fs.resolvePath(this.state.cwd, path),
      content,
    );
  }

  async readFileDirect(path: string): Promise<string> {
    const content = await this.fs.readFile(path, "utf-8");
    this.updateFileState(path, { content });
    return content;
  }

  async writeFileDirect(path: string, content: string): Promise<void> {
    await this.fs.writeFile(path, content);
    this.updateFileState(path, { content });

    // Notify LSP of change
    this.services.lspManager.sendNotification(path, "textDocument/didChange", {
      textDocument: { uri: `file://${path}`, version: 1 },
      contentChanges: [{ text: content }],
    });
  }

  async listDirDirect(path: string): Promise<string[]> {
    return this.fs.readdir(this.fs.resolvePath(this.state.cwd, path));
  }

  async existsDirect(path: string): Promise<boolean> {
    return this.fs.exists(this.fs.resolvePath(this.state.cwd, path));
  }

  async mkdirDirect(path: string, recursive = true): Promise<void> {
    await this.fs.mkdir(this.fs.resolvePath(this.state.cwd, path), {
      recursive,
    });
  }

  async rmDirect(path: string, recursive = false): Promise<void> {
    await this.fs.rm(this.fs.resolvePath(this.state.cwd, path), {
      recursive,
      force: true,
    });
  }

  getCwd(): string {
    return this.state.cwd;
  }

  getEnv(): Record<string, string> {
    return mapToRecord(this.state.env);
  }

  // biome-ignore lint/suspicious/noExplicitAny: type-erased plugin registration
  registerTransformPlugin(plugin: TransformPlugin<any>): void {
    this.transformPlugins.push(plugin);
  }

  transform(commandLine: string): BashTransformResult {
    const normalized = normalizeScript(commandLine);
    let ast = parse(normalized, {
      maxHeredocSize: this.limits.maxHeredocSize,
    });
    let metadata: Record<string, unknown> = Object.create(null);

    for (const plugin of this.transformPlugins) {
      const result = plugin.transform({ ast, metadata });
      ast = result.ast;
      if (result.metadata) {
        metadata = mergeToNullPrototype(metadata, result.metadata);
      }
    }

    return {
      script: serialize(ast),
      ast,
      metadata,
    };
  }

  destroy(): void {
    this.services.sharedBus.destroy();
    this.services.astCache.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.destroy();
  }
}

/**
 * Snapshot of a Bash instance state.
 */
export interface BashSnapshot {
  state: InterpreterState;
  fs: FileSystemSnapshot;
}

/**
 * Normalizes indented multi-line scripts (like those in template literals).
 */

/**
 * Normalize a script by stripping leading whitespace from lines,
 * while preserving whitespace inside heredoc content.
 *
 * This allows writing indented bash scripts in template literals:
 * ```
 * await bash.exec(`
 *   if [ -f foo ]; then
 *     echo "yes"
 *   fi
 * `);
 * ```
 *
 * Heredocs are detected by looking for << or <<- operators and their delimiters.
 */
function normalizeScript(script: string): string {
  const lines = script.split("\n");
  const result: string[] = [];

  // Stack of pending heredoc delimiters (for nested heredocs)
  const pendingDelimiters: { delimiter: string; stripTabs: boolean }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // If we're inside a heredoc, check if this line ends it
    if (pendingDelimiters.length > 0) {
      const current = pendingDelimiters[pendingDelimiters.length - 1];
      // For <<-, strip leading tabs when checking delimiter
      // For <<, require exact match (no leading whitespace allowed)
      const lineToCheck = current.stripTabs ? line.replace(/^\t+/, "") : line;
      if (lineToCheck === current.delimiter) {
        // End of heredoc - this line can be normalized
        result.push(line.trimStart());
        pendingDelimiters.pop();
        continue;
      }
      // Inside heredoc - preserve the line exactly as-is
      result.push(line);
      continue;
    }

    // Not inside a heredoc - normalize the line and check for heredoc starts
    const normalizedLine = line.trimStart();
    result.push(normalizedLine);

    // Check for heredoc operators in this line
    // Match: <<DELIM, <<-DELIM, << 'DELIM', <<- "DELIM", etc.
    // Multiple heredocs on one line are possible: cmd <<EOF1 <<EOF2
    const heredocPattern = /<<(-?)\s*(['"]?)([\w-]+)\2/g;
    for (const match of normalizedLine.matchAll(heredocPattern)) {
      const stripTabs = match[1] === "-";
      const delimiter = match[3];
      pendingDelimiters.push({ delimiter, stripTabs });
    }
  }

  return result.join("\n");
}

/**
 * Strict UTF-8 decoder that throws on invalid byte sequences.
 */
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Decode a binary string (latin1, where each char = one byte) to UTF-8.
 *
 * The internal pipeline uses binary strings for byte transparency (e.g.,
 * piping compressed data through cat). At the output boundary, we convert
 * valid UTF-8 byte sequences back to proper Unicode characters so that
 * multibyte text (CJK, Cyrillic, emoji) displays correctly.
 *
 * If the binary string does not contain valid UTF-8, it is returned as-is.
 */
function decodeBinaryToUtf8(s: string): string {
  if (!s) return s;

  // Scan the string to determine its type:
  // - All chars ≤ 0x7F: pure ASCII, no conversion needed
  // - Any char > 0xFF: already proper Unicode (from commands like printf, grep),
  //   not a binary string — return as-is
  // - Chars in 0x80-0xFF range only: binary string (latin1) that may contain
  //   UTF-8 byte sequences — try decoding
  let hasHighByte = false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0xff) {
      // Already a proper Unicode string, not a binary string
      return s;
    }
    if (code > 0x7f) {
      hasHighByte = true;
    }
  }
  if (!hasHighByte) return s;

  // Convert binary string to bytes
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i);
  }

  // Try UTF-8 decoding; fall back to binary string for non-UTF-8 data
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch {
    return s;
  }
}
