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
import { InMemoryFs } from "./fs/in-memory-fs/in-memory-fs.js";
import { initFilesystem } from "./fs/init.js";
import type { IFileSystem, InitialFiles } from "./fs/interface.js";
import { MountableFs, type MountConfig } from "./fs/mountable-fs/index.js";
import { sanitizeErrorMessage } from "./fs/sanitize-error.js";
import {
  mapToRecord,
  mapToRecordWithExtras,
  mergeToNullPrototype,
} from "./helpers/env.js";
import {
  ArithmeticError,
  ExecutionAbortedError,
  ExecutionLimitError,
  ExitError,
  PosixFatalError,
} from "./interpreter/errors.js";
import {
  buildBashopts,
  buildShellopts,
} from "./interpreter/helpers/shellopts.js";
import {
  type DebuggerBridge,
  Interpreter,
  type InterpreterOptions,
  type InterpreterState,
} from "./interpreter/index.js";
import { type ExecutionLimits, resolveLimits } from "./limits.js";
import { LSPManager } from "./lsp/LSPManager.js";
import { SemanticEngine } from "./lsp/semantic-engine.js";
import { WorkspaceIndexer } from "./lsp/WorkspaceIndexer.js";
import {
  createSecureFetch,
  type NetworkConfig,
  type SecureFetch,
} from "./network/index.js";
import { AgTrace } from "./observability/ag-trace.js";
import { ASTCache } from "./parser/ASTCache.js";
import { LexerError } from "./parser/lexer.js";
import { type ParseException, parse } from "./parser/parser.js";
import { TreeSitterParser } from "./parser/tree-sitter-parser.js";
import { TreeSitterToAst } from "./parser/tree-sitter-to-ast.js";
import {
  DefenseInDepthBox,
  SecurityViolationError,
} from "./security/defense-in-depth-box.js";
import type { DefenseInDepthConfig } from "./security/types.js";
import { SessionManager } from "./services/SessionManager.js";
import {
  applyStateDelta,
  type BashDelta,
  diffFs,
  diffState,
} from "./state-sync/index.js";
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

export interface BashOptions {
  files?: InitialFiles;
  env?: Record<string, string>;
  cwd?: string;
  fs?: IFileSystem;
  /**
   * Persistence configuration for the agent workspace.
   */
  persistence?: {
    root: string;
    mountPoint?: string;
  };
  /**
   * Current nesting depth (for sub-agent orchestration).
   * Defaults to 0 for root bash.
   */
  nestingDepth?: number;
  /**
   * Execution limits to prevent runaway compute.
   * See ExecutionLimits interface for available options.
   */
  executionLimits?: ExecutionLimits;
  /**
   * @deprecated Use executionLimits.maxCallDepth instead
   */
  maxCallDepth?: number;
  /**
   * @deprecated Use executionLimits.maxCommandCount instead
   */
  maxCommandCount?: number;
  /**
   * @deprecated Use executionLimits.maxLoopIterations instead
   */
  maxLoopIterations?: number;
  /**
   * Custom secure fetch function. When provided, used instead of creating one
   * from NetworkConfig. Enables wrapping the fetch layer with custom logic
   * (e.g., policy evaluation) while keeping built-in curl unmodified.
   * Network commands (curl, wget) are registered when either `fetch` or `network` is provided.
   */
  fetch?: SecureFetch;
  /**
   * Network configuration for commands like curl.
   * Network access is disabled by default - you must explicitly configure allowed URLs.
   */
  network?: NetworkConfig;
  /**
   * Enable python3/python commands.
   * Python is disabled by default as it introduces additional security surface
   * (arbitrary code execution via CPython Emscripten).
   */
  python?: boolean;
  /**
   * Enable js-exec command for sandboxed JavaScript execution via QuickJS.
   * Disabled by default. Can be a boolean or a config object with bootstrap code.
   */
  javascript?: boolean | JavaScriptConfig;
  /**
   * Optional list of command names to register.
   * If not provided, all built-in commands are available.
   * Use this to restrict which commands can be executed.
   */
  commands?: CommandName[];
  /**
   * Optional sleep function for the sleep command.
   * If provided, used instead of real setTimeout.
   * Useful for testing with mock clocks.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional handler for when a command is not found.
   * If provided, called with the command name and arguments.
   * Return null to fall back to the standard "command not found" error.
   */
  onCommandNotFound?: (
    command: string,
    args: string[],
  ) => Promise<ExecResult | null>;
  /**
   * Custom commands to register alongside built-in commands.
   * These take precedence over built-ins with the same name.
   *
   * @example
   * ```ts
   * import { defineCommand } from "ag-bash";
   *
   * const hello = defineCommand("hello", async (args) => ({
   *   stdout: `Hello, ${args[0] || "world"}!\n`,
   *   stderr: "",
   *   exitCode: 0,
   * }));
   *
   * const bash = new Bash({ customCommands: [hello] });
   * ```
   */
  customCommands?: CustomCommand[];
  /**
   * Optional logger for execution tracing.
   * When provided, logs exec commands (info), stdout (debug), stderr (info), and exit codes (info).
   * Disabled by default.
   */
  logger?: BashLogger;
  /**
   * Optional trace callback for performance profiling.
   * When provided, commands emit timing events for analysis.
   * Useful for identifying performance bottlenecks.
   */
  trace?: TraceCallback;
  /**
   * Defense-in-depth configuration.
   *
   * When enabled, monkey-patches dangerous JavaScript globals (Function, eval,
   * setTimeout, process, etc.) during script execution to block potential
   * escape vectors.
   *
   * IMPORTANT: This is a SECONDARY defense layer. It should never be relied
   * upon as the primary security mechanism. The primary security comes from
   * proper sandboxing, input validation, and architectural constraints.
   *
   * @example
   * ```ts
   * // Simple enable
   * const bash = new Bash({ defenseInDepth: true });
   *
   * // With custom configuration
   * const bash = new Bash({
   *   defenseInDepth: {
   *     enabled: true,
   *     auditMode: false, // Set to true to log but not block
   *     onViolation: (v) => console.warn('Violation:', v),
   *   },
   * });
   * ```
   */
  defenseInDepth?: DefenseInDepthConfig | boolean;
  /**
   * Feature coverage writer for fuzzing instrumentation.
   * When provided, interpreter emits coverage hits for analysis.
   */
  coverage?: FeatureCoverageWriter;
  /**
   * Virtual process info for sandboxed environment.
   * Overrides the default virtual PID/UID values exposed via $$, $PPID, $UID, $EUID, $BASHPID,
   * and /proc/self/status. Real host process info is never exposed.
   */
  processInfo?: {
    pid?: number;
    ppid?: number;
    uid?: number;
    gid?: number;
  };
  /**
   * If true, commit execution state back to the Bash instance after success by default.
   * Persists CWD, environment variables, and functions.
   * Individual exec calls can override this.
   */
  persistState?: boolean;
  /**
   * Selection of the parser engine to use.
   * - 'legacy': The hand-written recursive descent parser (v1.x/v2.x).
   * - 'tree-sitter': The robust AST-based parser engine (v1.4.0+).
   * Default: 'tree-sitter'
   */
  parserEngine?: "legacy" | "tree-sitter";
  /**
   * If true, enables agentic behavior for the shell.
   * This includes automatic AI intervention on command failure if an agent gateway is configured.
   */
  agentic?: boolean;
  /**
   * Configuration for the agentic healer.
   */
  agenticConfig?: AgenticHealerConfig;
  /**
   * Configuration for the Tree-sitter parser engine.
   * Required if parserEngine is set to 'tree-sitter'.
   */
  treeSitterConfig?: {
    webTreeSitterWasm: string | Uint8Array;
    bashGrammarWasm?: string | Uint8Array;
    grammars?: Record<string, string | Uint8Array>;
  };
  /**
   * Optional debugger for statement-level control.
   */
  debugger?: DebuggerBridge;
  /**
   * Optional semantic engine for AST analysis.
   */
  semanticEngine?: SemanticEngine;
}

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
}

export class Bash {
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
  private parserEngine: "legacy" | "tree-sitter";
  private treeSitterConfig?: BashOptions["treeSitterConfig"];
  private agentic: boolean;
  private debugger?: DebuggerBridge;
  public semanticEngine: SemanticEngine;
  public indexer: WorkspaceIndexer;
  private agenticHealer?: AgenticHealer;
  public toolbox: BashToolbox;
  public readonly nestingDepth: number;

  // Interpreter state (shared with interpreter instances)
  private state: InterpreterState;
  private snapshots: Map<string, BashSnapshot> = new Map();

  constructor(options: BashOptions = {}) {
    this.nestingDepth = options.nestingDepth ?? 0;
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

    // Resolve limits: new executionLimits takes precedence, then deprecated individual options
    this.limits = resolveLimits({
      ...options.executionLimits,
      // Support deprecated individual options (they override executionLimits if set)
      ...(options.maxCallDepth !== undefined && {
        maxCallDepth: options.maxCallDepth,
      }),
      ...(options.maxCommandCount !== undefined && {
        maxCommandCount: options.maxCommandCount,
      }),
      ...(options.maxLoopIterations !== undefined && {
        maxLoopIterations: options.maxLoopIterations,
      }),
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
    this.traceFn = options.trace;

    // Store logger if provided
    this.logger = options.logger;

    // Store onCommandNotFound hook if provided
    this.onCommandNotFound = options.onCommandNotFound;

    // Defense-in-depth defaults to enabled
    this.defenseInDepthConfig = options.defenseInDepth ?? true;

    // Agentic behavior defaults to false
    this.agentic = options.agentic ?? false;

    // Store coverage writer if provided (for fuzzing instrumentation)
    this.coverageWriter = options.coverage;

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
      virtualPid: options.processInfo?.pid ?? 1,
      virtualPpid: options.processInfo?.ppid ?? 0,
      virtualUid: options.processInfo?.uid ?? 1000,
      virtualGid: options.processInfo?.gid ?? 1000,
      bashPid: options.processInfo?.pid ?? 1, // BASHPID starts as virtual PID
      nextVirtualPid: (options.processInfo?.pid ?? 1) + 1, // Counter for unique subshell PIDs
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
    if (options.python) {
      for (const cmd of createPythonCommands()) {
        this.registerCommand(cmd);
      }
    }

    // Register javascript commands only when explicitly enabled
    if (options.javascript) {
      for (const cmd of createJavaScriptCommands()) {
        this.registerCommand(cmd);
      }
      // Store bootstrap code in private field (threaded via context chain, not env)
      const jsConfig =
        typeof options.javascript === "object"
          ? options.javascript
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
    this.parserEngine = options.parserEngine ?? "legacy";
    this.treeSitterConfig = options.treeSitterConfig;
    this.debugger = options.debugger;
    this.semanticEngine = options.semanticEngine ?? new SemanticEngine();
    this.indexer = new WorkspaceIndexer(this, this.semanticEngine);
    this.agentic = options.agentic ?? false;
    if (this.agentic) {
      this.agenticHealer = new AgenticHealer(
        options.agenticConfig || { enableHeuristics: true },
      );
    }
  }

  /**
   * Close a persistent session and terminate its worker.
   */
  public async closeSession(sessionId: string): Promise<void> {
    await SessionManager.getInstance().terminateSession(sessionId);
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
    const res: Record<string, string> = {};
    for (const [k, v] of this.state.env) {
      res[k] = v;
    }
    return res;
  }

  private async initLsp(): Promise<void> {
    const lsp = LSPManager.getInstance();
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

    // Log command execution
    this.logger?.info("exec", { command: commandLine });

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
    let normalized = commandLine;
    if (!options?.rawScript) {
      normalized = normalizeScript(commandLine);
    }

    // Activate defense-in-depth box if configured
    // This wraps execution in AsyncLocalStorage context for context-aware blocking
    const defenseBox = this.defenseInDepthConfig
      ? DefenseInDepthBox.getInstance(this.defenseInDepthConfig)
      : null;

    // Pre-initialize Tree-sitter outside of the defense-in-depth sandbox
    // because its WASM/JS glue code uses dynamic imports (e.g., 'module', 'fs')
    // that are blocked during sandboxed script execution.
    if (this.parserEngine === "tree-sitter" && this.treeSitterConfig) {
      const grammars = { ...this.treeSitterConfig.grammars };
      if (this.treeSitterConfig.bashGrammarWasm) {
        grammars.bash = this.treeSitterConfig.bashGrammarWasm;
      }
      await TreeSitterParser.init({
        webTreeSitterWasm: this.treeSitterConfig.webTreeSitterWasm,
        grammars,
      });
    }

    const defenseHandle = defenseBox?.activate();

    try {
      // Run execution inside defense-in-depth context if enabled
      const executeScript = async (): Promise<BashExecResult> => {
        let ast: ScriptNode;

        const astCache = ASTCache.getInstance();
        const cachedAst = astCache.get(normalized);
        if (cachedAst) {
          ast = cachedAst;
        } else {
          if (this.parserEngine === "tree-sitter" && this.treeSitterConfig) {
            const tree = TreeSitterParser.parse(normalized);
            const converter = new TreeSitterToAst(normalized);
            ast = converter.convert(tree);
          } else {
            ast = parse(normalized, {
              maxHeredocSize: this.limits.maxHeredocSize,
            }) as ScriptNode;
          }
          astCache.set(normalized, ast);
        }

        // Apply transform plugins if any are registered.
        // Keep metadata null-prototype even when plugins contribute dynamic keys.
        let metadata: ReturnType<typeof mergeToNullPrototype> | undefined;
        if (this.transformPlugins.length > 0) {
          let meta: Record<string, unknown> = Object.create(null);
          for (const plugin of this.transformPlugins) {
            const pluginResult = plugin.transform({ ast, metadata: meta });
            ast = pluginResult.ast;
            if (pluginResult.metadata) {
              meta = mergeToNullPrototype(meta, pluginResult.metadata);
            }
          }
          metadata = meta;
        }

        // Create interpreter with appropriate state
        const interpreterOptions: InterpreterOptions = {
          fs: this.fs,
          commands: this.commands,
          limits: this.limits,
          exec: this.exec.bind(this),
          fetch: this.secureFetch,
          sleep: this.sleepFn,
          trace: this.traceFn,
          coverage: this.coverageWriter,
          requireDefenseContext: defenseBox?.isEnabled() === true,
          jsBootstrapCode: this.jsBootstrapCode,
          onCommandNotFound: this.onCommandNotFound,
          agentic: this.agentic,
          getRegisteredCommands: () => Array.from(this.commands.keys()),
          debugger: options?.debugger ?? this.debugger,
          semanticEngine: options?.semanticEngine ?? this.semanticEngine,
          agenticHealer: options?.agenticHealer ?? this.agenticHealer,
          bash: this,
        };

        const interpreter = new Interpreter(interpreterOptions, execState);
        const result = await interpreter.executeScript(ast);
        // Interpreter always sets env, assert it for type safety
        const execResult = result as BashExecResult;
        if (metadata) {
          execResult.metadata = metadata;
        }
        return this.logResult(execResult);
      };

      const execResult = await (defenseHandle
        ? defenseHandle.run(executeScript)
        : executeScript());

      // If persistence is enabled, commit the state back to the Bash instance
      const shouldPersist = options?.persistState ?? this.defaultPersistState;
      if (shouldPersist && execResult.exitCode === 0) {
        this.state.cwd = execState.cwd;
        this.state.env = execState.env;
        this.state.functions = execState.functions;
        this.state.lastExitCode = execResult.exitCode;
        this.state.shoptOptions = { ...execState.shoptOptions };
        this.state.options = { ...execState.options };
        this.state.hashTable = execState.hashTable;
      }

      return execResult;
    } catch (error: any) {
      // ExitError propagates from 'exit' builtin (including via eval/source)
      if (error instanceof ExitError || error.name === "ExitError") {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode,
          env: mapToRecordWithExtras(this.state.env, options?.env),
          observations: [AgTrace.analyzeError(error)],
        });
      }
      // PosixFatalError propagates from special builtins in POSIX mode
      if (error instanceof PosixFatalError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode,
          env: mapToRecordWithExtras(this.state.env, options?.env),
          observations: [AgTrace.analyzeError(error)],
        });
      }
      if (error instanceof ArithmeticError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: 1,
          env: mapToRecordWithExtras(this.state.env, options?.env),
          observations: [AgTrace.analyzeError(error)],
        });
      }
      // ExecutionAbortedError is thrown when an AbortSignal fires (timeout cancellation)
      if (error instanceof ExecutionAbortedError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: 124, // Same as timeout exit code
          env: mapToRecordWithExtras(this.state.env, options?.env),
          observations: [AgTrace.analyzeError(error)],
        });
      }
      // SecurityViolationError is thrown when defense-in-depth detects a blocked operation
      const errorName = error instanceof Error ? error.name : "";
      if (
        error instanceof SecurityViolationError ||
        errorName === "SecurityViolationError"
      ) {
        return this.logResult({
          stdout: "",
          stderr: `bash: security violation: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}\n`,
          exitCode: 1,
          env: mapToRecordWithExtras(this.state.env, options?.env),
          observations: [AgTrace.analyzeError(error as Error)],
        });
      }

      // ExecutionLimitError is thrown when command limits are exceeded during interpreter loop
      if (
        error instanceof ExecutionLimitError ||
        errorName === "ExecutionLimitError"
      ) {
        return this.logResult({
          stdout: "",
          stderr: `bash: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}\n`,
          exitCode: ExecutionLimitError.EXIT_CODE,
          env: mapToRecordWithExtras(this.state.env, options?.env),
          observations: [AgTrace.analyzeError(error as Error)],
        });
      }

      if ((error as ParseException).name === "ParseException") {
        return this.logResult({
          stdout: "",
          stderr: `bash: syntax error: ${sanitizeErrorMessage((error as Error).message)}\n`,
          exitCode: 2,
          env: mapToRecordWithExtras(this.state.env, options?.env),
          observations: [AgTrace.analyzeError(error as Error)],
        });
      }
      // LexerError is thrown for lexer-level issues like unterminated quotes
      if (error instanceof LexerError) {
        return this.logResult({
          stdout: "",
          stderr: `bash: ${sanitizeErrorMessage(error.message)}\n`,
          exitCode: 2,
          env: mapToRecordWithExtras(this.state.env, options?.env),
          observations: [AgTrace.analyzeError(error)],
        });
      }
      // RangeError occurs when JavaScript call stack is exceeded (deep recursion)
      if (error instanceof RangeError) {
        return this.logResult({
          stdout: "",
          stderr: `bash: ${sanitizeErrorMessage(error.message)}\n`,
          exitCode: 1,
          env: mapToRecordWithExtras(this.state.env, options?.env),
          observations: [AgTrace.analyzeError(error)],
        });
      }
      throw error;
    } finally {
      // Always deactivate defense-in-depth box when done
      defenseHandle?.deactivate();
    }
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
    delta.fsDelta = diffFs(
      base.fs as Map<string, any>,
      current.fs as Map<string, any>,
    );
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
    LSPManager.getInstance().sendNotification(path, "textDocument/didChange", {
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
}

/**
 * Snapshot of a Bash instance state.
 */
export interface BashSnapshot {
  state: InterpreterState;
  fs: unknown;
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
