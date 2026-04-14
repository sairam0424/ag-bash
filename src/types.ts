export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  env?: Record<string, string>;
  stdoutEncoding?: "binary";
}

export interface BashExecResult extends ExecResult {
  env: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface CommandExecOptions {
  env?: Record<string, string>;
  replaceEnv?: boolean;
  cwd: string;
  stdin?: string;
  signal?: AbortSignal;
  args?: string[];
}

export interface IFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string): Promise<void>;
}

export interface ExecutionLimits {
  maxSteps?: number;
  maxFiles?: number;
  maxStdoutSize?: number;
}

export interface CommandContext {
  fs: IFileSystem;
  cwd: string;
  env: Map<string, string>;
  exportedEnv?: Record<string, string>;
  stdin: string;
  limits?: Required<ExecutionLimits>;
  exec?: (command: string, options: CommandExecOptions) => Promise<ExecResult>;
  signal?: AbortSignal;
}

export interface Command {
  name: string;
  execute(args: string[], ctx: CommandContext): Promise<ExecResult>;
}

export type CommandRegistry = Map<string, Command>;
