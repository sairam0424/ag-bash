import type { IFileSystem } from "./fs/interface.js";
import type { ExecutionLimits } from "./limits.js";
import type {
  SemanticSymbol,
  SymbolOccurrence,
} from "./lsp/semantic-engine.js";
import type { SecureFetch } from "./network/index.js";
import type { ServiceContainer } from "./services/ServiceContainer.js";

/**
 * Lightweight interface for feature coverage tracking during fuzzing.
 * Lives here to avoid circular dependencies between fuzzing → core modules.
 */
export interface FeatureCoverageWriter {
  hit(feature: string): void;
}

/**
 * Structured observation about an execution failure or anomaly.
 * Used by agents to understand failures beyond just stderr.
 */
export interface Observation {
  type:
    | "command_not_found"
    | "file_not_found"
    | "directory_not_found"
    | "permission_denied"
    | "limit_exceeded"
    | "syntax_error"
    | "security_violation"
    | "destructive"
    | "suggestion"
    | "unknown";
  message: string;
  /** Command name that failed */
  command?: string;
  /** Path related to the failure (if any) */
  path?: string;
  /** Corrective suggestions for the agent */
  suggestions?: string[];
  /** Detailed technical context */
  context?: Record<string, unknown>;
  /**
   * Stable, machine-readable code for this observation (e.g. "ENOENT",
   * "CMD_NOT_FOUND", "EACCES"). Unlike `type` (a coarse category) and
   * `message` (human prose that may change), `code` is a stable identifier
   * agents can switch on without parsing English. Optional for backward
   * compatibility with observations produced before A3.
   */
  code?: string;
  /**
   * Confidence (0..1) that this observation correctly diagnoses the failure.
   * Source-emitted observations (the interpreter/command KNEW the typed cause)
   * are high-confidence (1.0). Heuristic/regex-scraped observations from
   * AgTrace are lower. Optional for backward compatibility.
   */
  confidence?: number;
}

/**
 * The result of executing a bash command or script.
 * Check `exitCode` for success (0) or failure (non-zero).
 *
 * @example
 * ```ts
 * const { stdout, stderr, exitCode, observations } = await bash.exec("ls /tmp");
 * if (exitCode !== 0) console.error(stderr);
 * ```
 */
export interface ExecResult {
  /** Standard output produced by the command. */
  stdout: string;
  /** Standard error produced by the command. */
  stderr: string;
  /** Process exit code: 0 = success, non-zero = failure. */
  exitCode: number;
  /** The final environment variables after execution (only set by Bash.exec) */
  env?: Record<string, string>;
  /**
   * Encoding hint for stdout content when writing to files via redirections.
   * Set to "binary" by commands that produce binary output (e.g., cat, gzip)
   * to prevent re-encoding of raw byte data as UTF-8.
   * When not set, the redirect system uses UTF-8 for non-ASCII text.
   */
  stdoutEncoding?: "binary";
  /** Structured observations about failures — agents use these for self-correction. */
  observations?: Observation[];
  /** Reasoning effort level applied as a context modifier for subsequent turns */
  effort?: "low" | "medium" | "high";
  /** Advanced composition hooks for the orchestration layer */
  composeHooks?: { before?: string[]; after?: string[]; parallel?: string[] };
}

/** Result from Bash.exec() - always includes env */
export interface BashExecResult extends ExecResult {
  env: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/**
 * A single incremental output fragment produced during execution.
 * Emitted to an {@link OutputSink} as commands write to stdout/stderr,
 * preserving the order in which the bytes were produced.
 */
export interface StreamChunk {
  /** Which standard stream produced this fragment. */
  type: "stdout" | "stderr";
  /** The raw text fragment. The concatenation of all fragments of a given
   *  type equals the corresponding buffered ExecResult field, byte-for-byte. */
  data: string;
}

/**
 * Opt-in callback that receives output fragments incrementally as a script
 * executes. When NOT supplied to exec(), execution is byte-identical to the
 * buffered path with zero measurable overhead (the sink is simply never
 * invoked). Used by StreamingExecutor to drive true incremental streaming.
 */
export type OutputSink = (chunk: StreamChunk) => void;

/** Options for exec calls within commands (internal API) */
export interface CommandExecOptions {
  /** Environment variables to merge into the exec state */
  env?: Record<string, string>;
  /**
   * Replace the execution environment instead of merging with parent env.
   * Useful for implementing `env -i` semantics safely without shell prefixes.
   */
  replaceEnv?: boolean;
  /**
   * Working directory for the exec.
   * Required to prevent bugs where subcommands run in the wrong directory.
   * Always pass `ctx.cwd` from the calling command's context.
   */
  cwd: string;
  /**
   * Standard input to pass to the subcommand.
   * Optional - if not provided, stdin will be empty.
   */
  stdin?: string;
  /**
   * Abort signal for cooperative cancellation.
   * When aborted, the interpreter stops executing at the next statement boundary.
   * Used by `timeout` to ensure timed-out commands don't continue running.
   */
  signal?: AbortSignal;
  /**
   * Additional argv entries appended to the first executed command.
   * Values bypass shell parsing entirely — no escaping, splitting, or globbing.
   * Like child_process.spawnSync(cmd, args).
   */
  args?: string[];
}

/**
 * Context provided to commands during execution.
 *
 * ## Field Availability
 *
 * **Always available (core fields):**
 * - `fs`, `cwd`, `env`, `stdin`
 *
 * **Available when running via Bash interpreter:**
 * - `exec` - For commands like `xargs`, `bash -c` that need to run subcommands
 * - `getRegisteredCommands` - For the `help` command to list available commands
 *
 * **Conditionally available based on configuration:**
 * - `fetch` - Only when `network` option is configured in Bash
 * - `sleep` - Only when a custom sleep function is provided (e.g., for testing)
 */
/**
 * Performance trace event for profiling command execution
 */
export interface TraceEvent {
  /** Event category (e.g., "find", "grep") */
  category: string;
  /** Event name (e.g., "readdir", "stat", "eval") */
  name: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Optional details (e.g., path, count) */
  details?: Record<string, unknown>;
}

/**
 * Trace callback function for receiving performance events
 */
export type TraceCallback = (event: TraceEvent) => void;

/**
 * Minimal interface exposing Bash instance capabilities to commands.
 * Replaces raw `any` reference to the Bash class, providing only the
 * surface area that commands actually need.
 */
export interface BashHost {
  /** Service container for accessing shared services (agents, MCP, etc.) */
  readonly services: ServiceContainer;
  /** Execution limits configuration */
  readonly limits: Required<ExecutionLimits>;
  /**
   * The virtual filesystem backing this shell. Sub-agent spawning layers a
   * CoW overlay on top of this parent filesystem.
   */
  readonly fs: IFileSystem;
  /**
   * Current agent nesting depth (0 for a root shell). Used to enforce the
   * `maxAgentNesting` limit when spawning sub-agents.
   */
  readonly nestingDepth: number;
  /** Returns the current working directory. */
  getCwd(): string;
  /** Returns a snapshot of the environment variables as a null-prototype record. */
  getEnv(): Record<string, string>;
  /** Semantic engine for symbol resolution */
  readonly semanticEngine: {
    findDefinition(name: string, scope?: string): SemanticSymbol | undefined;
    getOccurrences(name: string): SymbolOccurrence[];
    getAllSymbols(): SemanticSymbol[];
    indexNode(node: unknown, path?: string, language?: string): void;
  };
  /** Workspace indexer for symbol search */
  readonly indexer: {
    findSymbols(query?: string): Promise<unknown[]>;
  };
  /** LSP manager for language server notifications */
  readonly lsp: {
    notifyDidChange(filePath: string, content: string): void;
  };
  /** Toolbox for registering MCP tools */
  readonly toolbox: {
    registerMcpTools(connectionId: string, tools: unknown[]): void;
  };
  /** Whether agentic mode is enabled */
  readonly agentic?: boolean;
  /** Set the shell mode (execute or plan) */
  setMode(mode: "execute" | "plan"): void;
  /** Get the current shell mode */
  getMode(): "execute" | "plan";
}

export interface CommandContext {
  /** Virtual filesystem interface for file operations */
  fs: IFileSystem;
  /** Current working directory */
  cwd: string;
  /** Environment variables - uses Map to prevent prototype pollution */
  env: Map<string, string>;
  /**
   * Exported environment variables only.
   * Used by commands like printenv and env that should only show exported vars.
   * In bash, only exported variables are passed to child processes.
   */
  exportedEnv?: Record<string, string>;
  /** Standard input content */
  stdin: string;
  /**
   * Execution limits configuration.
   * Available when running commands via Bash interpreter.
   */
  limits?: Required<ExecutionLimits>;
  /**
   * Performance trace callback for profiling.
   * If provided, commands emit timing events for analysis.
   */
  trace?: TraceCallback;
  /**
   * Execute a subcommand (e.g., for `xargs`, `bash -c`).
   * Available when running commands via Bash interpreter.
   *
   * @param command - The command string to execute
   * @param options - Required options including `cwd` to prevent directory bugs
   */
  exec?: (command: string, options: CommandExecOptions) => Promise<ExecResult>;
  /**
   * Secure fetch function for network requests (e.g., for `curl`).
   * Only available when `network` option is configured in Bash.
   */
  fetch?: SecureFetch;
  /**
   * Returns names of all registered commands.
   * Available when running commands via Bash interpreter.
   * Used by the `help` command.
   */
  getRegisteredCommands?: () => string[];
  /**
   * Custom sleep implementation.
   * If provided, used instead of real setTimeout.
   * Useful for testing with mock clocks.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * File descriptors map for here-docs and process substitution.
   * Maps FD numbers to their content (e.g., 3 -> "content from 3<<EOF").
   * Note: FD 0 content is in `stdin`, but may also appear here for consistency.
   */
  fileDescriptors?: Map<number, string>;
  /**
   * Whether xpg_echo shopt is enabled.
   * When true, echo interprets backslash escapes by default (like echo -e).
   */
  xpgEcho?: boolean;
  /**
   * Current command substitution nesting depth.
   * Used to prevent stack exhaustion from deeply nested $(...).
   */
  substitutionDepth?: number;
  /**
   * Feature coverage writer for fuzzing instrumentation.
   * When provided, commands emit coverage hits for analysis.
   */
  coverage?: FeatureCoverageWriter;
  /**
   * Abort signal from the current execution context.
   * Commands that spawn sub-executions (bash -c, xargs, etc.)
   * should forward this signal so cooperative cancellation propagates.
   */
  signal?: AbortSignal;
  /**
   * When true, command execution must remain inside DefenseInDepthBox
   * async context. Commands with async boundaries should assert this
   * before and after awaited operations.
   */
  requireDefenseContext?: boolean;
  /**
   * Bootstrap JavaScript code for js-exec.
   * Threaded through the context chain instead of shell env to prevent
   * user access/injection via environment variables.
   */
  jsBootstrapCode?: string;
  /** Current session ID for stateful REPLs */
  sessionId?: string;
  /** Reference to the parent Bash instance (for service access) */
  bash?: BashHost;
}

export interface Command {
  name: string;
  /**
   * When true, execute this command inside DefenseInDepthBox.runTrustedAsync().
   * Use for trusted host-extension commands that need direct Node.js globals.
   * Built-in commands should generally remain untrusted and use explicit
   * trusted wrappers only at narrow infrastructure boundaries.
   */
  trusted?: boolean;
  execute(args: string[], ctx: CommandContext): Promise<ExecResult>;
}

export type CommandRegistry = Map<string, Command>;

// Re-export IFileSystem for convenience
export type { IFileSystem };
