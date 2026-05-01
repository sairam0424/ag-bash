/**
 * Bash - Bash Shell Environment
 *
 * A complete bash-like shell environment using a proper AST-based architecture:
 *   Input → Parser → AST → Interpreter → Output
 *
 * This class provides the shell environment (filesystem, commands, variables)
 * and delegates execution to the Interpreter.
 */
import "./timers.js";
import { type CommandName } from "./commands/registry.js";
import { type CustomCommand } from "./custom-commands.js";
import type { IFileSystem, InitialFiles } from "./fs/interface.js";
import { type ExecutionLimits } from "./limits.js";
import { type NetworkConfig, type SecureFetch } from "./network/index.js";
import type { DefenseInDepthConfig } from "./security/types.js";
import type { ServiceContainer } from "./services/ServiceContainer.js";
import type {
  BashTransformResult,
  TransformPlugin,
} from "./transform/types.js";
import type {
  BashExecResult,
  Command,
  ExecResult,
  FeatureCoverageWriter,
  TraceCallback,
} from "./types.js";
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
  commands?: CommandName[];
  customCommands?: CustomCommand[];
  executionLimits?: ExecutionLimits;
  persistState?: boolean;
  sleep?: (ms: number) => Promise<void>;
  onCommandNotFound?: (
    command: string,
    args: string[],
  ) => Promise<ExecResult | null>;
  persistence?: {
    root: string;
    mountPoint?: string;
  };
  runtimes?: {
    python?: boolean;
    javascript?: boolean | JavaScriptConfig;
  };
  network?: NetworkConfig;
  fetch?: SecureFetch;
  security?: {
    defenseInDepth?: DefenseInDepthConfig | boolean;
    processInfo?: {
      pid?: number;
      ppid?: number;
      uid?: number;
      gid?: number;
    };
  };
  agentic?: {
    enabled?: boolean;
    healer?: any;
    permissionHandler?: any;
    nestingDepth?: number;
  };
  parser?: {
    engine?: "legacy" | "tree-sitter";
    treeSitterConfig?: {
      webTreeSitterWasm: string | Uint8Array;
      bashGrammarWasm?: string | Uint8Array;
      grammars?: Record<string, string | Uint8Array>;
    };
  };
  debug?: {
    logger?: BashLogger;
    trace?: TraceCallback;
    coverage?: FeatureCoverageWriter;
    debugger?: any;
    semanticEngine?: any;
  };
  services?: Partial<ServiceContainer>;
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
}
export declare class Bash {
  readonly fs: IFileSystem;
  readonly services: ServiceContainer;
  private commands;
  private useDefaultLayout;
  private limits;
  private secureFetch?;
  private sleepFn?;
  private traceFn?;
  private logger?;
  private defenseInDepthConfig?;
  private coverageWriter?;
  private jsBootstrapCode?;
  private onCommandNotFound?;
  private transformPlugins;
  private defaultPersistState;
  private state;
  constructor(options?: BashOptions);
  registerCommand(command: Command): void;
  private logResult;
  exec(commandLine: string, options?: ExecOptions): Promise<BashExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  getCwd(): string;
  getEnv(): Record<string, string>;
  registerTransformPlugin(plugin: TransformPlugin<any>): void;
  transform(commandLine: string): BashTransformResult;
}
