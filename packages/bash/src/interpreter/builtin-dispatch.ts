/**
 * Builtin Command Dispatch
 *
 * Handles dispatch of built-in shell commands like export, unset, cd, etc.
 * Separated from interpreter.ts for modularity.
 */

import { isBrowserExcludedCommand } from "../commands/browser-excluded.js";
import { sanitizeErrorMessage } from "../fs/sanitize-error.js";
import { awaitWithDefenseContext } from "../security/defense-context.js";
import {
  DefenseInDepthBox,
  SecurityViolationError,
} from "../security/defense-in-depth-box.js";
import type { CommandContext, ExecResult } from "../types.js";
import {
  handleAlias,
  handleBreak,
  handleCd,
  handleCompgen,
  handleComplete,
  handleCompopt,
  handleContinue,
  handleDeclare,
  handleDirs,
  handleEval,
  handleExit,
  handleExport,
  handleGetopts,
  handleHash,
  handleHelp,
  handleLet,
  handleLocal,
  handleMapfile,
  handlePopd,
  handlePushd,
  handleRead,
  handleReadonly,
  handleReturn,
  handleSet,
  handleShift,
  handleSource,
  handleTrap,
  handleUnalias,
  handleUnset,
} from "./builtins/index.js";
import { handleShopt } from "./builtins/shopt.js";
import {
  findCommandInPath as findCommandInPathHelper,
  resolveCommand as resolveCommandHelper,
} from "./command-resolution.js";
import { evaluateTestArgs } from "./conditionals.js";
import { createDefenseAwareCommandContext } from "./defense-aware-command-context.js";
import { ExecutionLimitError } from "./errors.js";
import { callFunction } from "./functions.js";
import { getErrorMessage } from "./helpers/errors.js";
import { failure, OK, testResult } from "./helpers/result.js";
import { SHELL_BUILTINS } from "./helpers/shell-constants.js";
import {
  findFirstInPath as findFirstInPathHelper,
  handleCommandV as handleCommandVHelper,
  handleType as handleTypeHelper,
} from "./type-command.js";
import type { InterpreterContext } from "./types.js";

/**
 * Type for the function that runs a command recursively
 */
export type RunCommandFn = (
  commandName: string,
  args: string[],
  quotedArgs: boolean[],
  stdin: string,
  skipFunctions?: boolean,
  useDefaultPath?: boolean,
  stdinSourceFd?: number,
) => Promise<ExecResult>;

/**
 * Type for the function that builds exported environment
 */
export type BuildExportedEnvFn = () => Record<string, string>;

/**
 * Type for the function that executes user scripts
 */
export type ExecuteUserScriptFn = (
  scriptPath: string,
  args: string[],
  stdin?: string,
) => Promise<ExecResult>;

/**
 * Dispatch context containing dependencies needed for builtin dispatch
 */
export interface BuiltinDispatchContext {
  ctx: InterpreterContext;
  runCommand: RunCommandFn;
  buildExportedEnv: BuildExportedEnvFn;
  executeUserScript: ExecuteUserScriptFn;
}

/**
 * Handler type for builtin dispatch map entries.
 * Receives the full dispatch arguments and returns an ExecResult or null.
 */
type BuiltinHandler = (
  dispatchCtx: BuiltinDispatchContext,
  args: string[],
  stdin: string,
  stdinSourceFd: number,
) => Promise<ExecResult> | ExecResult;

/**
 * Special builtins that cannot be overridden by functions.
 * These are checked BEFORE user-defined function lookup.
 */
const SPECIAL_BUILTIN_MAP = new Map<string, BuiltinHandler>();
SPECIAL_BUILTIN_MAP.set("export", ({ ctx }, args) => handleExport(ctx, args));
SPECIAL_BUILTIN_MAP.set("unset", ({ ctx }, args) => handleUnset(ctx, args));
SPECIAL_BUILTIN_MAP.set("exit", ({ ctx }, args) => handleExit(ctx, args));
SPECIAL_BUILTIN_MAP.set("local", ({ ctx }, args) => handleLocal(ctx, args));
SPECIAL_BUILTIN_MAP.set("set", ({ ctx }, args) => handleSet(ctx, args));
SPECIAL_BUILTIN_MAP.set("break", ({ ctx }, args) => handleBreak(ctx, args));
SPECIAL_BUILTIN_MAP.set("continue", ({ ctx }, args) => handleContinue(ctx, args));
SPECIAL_BUILTIN_MAP.set("return", ({ ctx }, args) => handleReturn(ctx, args));
SPECIAL_BUILTIN_MAP.set("shift", ({ ctx }, args) => handleShift(ctx, args));
SPECIAL_BUILTIN_MAP.set("getopts", ({ ctx }, args) => handleGetopts(ctx, args));
SPECIAL_BUILTIN_MAP.set("compgen", ({ ctx }, args) => handleCompgen(ctx, args));
SPECIAL_BUILTIN_MAP.set("complete", ({ ctx }, args) => handleComplete(ctx, args));
SPECIAL_BUILTIN_MAP.set("compopt", ({ ctx }, args) => handleCompopt(ctx, args));
SPECIAL_BUILTIN_MAP.set("pushd", ({ ctx }, args) => handlePushd(ctx, args));
SPECIAL_BUILTIN_MAP.set("popd", ({ ctx }, args) => handlePopd(ctx, args));
SPECIAL_BUILTIN_MAP.set("dirs", ({ ctx }, args) => handleDirs(ctx, args));
SPECIAL_BUILTIN_MAP.set("source", ({ ctx }, args) => handleSource(ctx, args));
SPECIAL_BUILTIN_MAP.set(".", ({ ctx }, args) => handleSource(ctx, args));
SPECIAL_BUILTIN_MAP.set("read", ({ ctx }, args, stdin, stdinSourceFd) =>
  handleRead(ctx, args, stdin, stdinSourceFd),
);
SPECIAL_BUILTIN_MAP.set("mapfile", ({ ctx }, args, stdin) => handleMapfile(ctx, args, stdin));
SPECIAL_BUILTIN_MAP.set("readarray", ({ ctx }, args, stdin) => handleMapfile(ctx, args, stdin));
SPECIAL_BUILTIN_MAP.set("declare", ({ ctx }, args) => handleDeclare(ctx, args));
SPECIAL_BUILTIN_MAP.set("typeset", ({ ctx }, args) => handleDeclare(ctx, args));
SPECIAL_BUILTIN_MAP.set("readonly", ({ ctx }, args) => handleReadonly(ctx, args));
SPECIAL_BUILTIN_MAP.set("trap", ({ ctx }, args) => handleTrap(ctx, args));

/**
 * Regular builtins that CAN be overridden by user-defined functions.
 * These are checked AFTER user-defined function lookup.
 */
const REGULAR_BUILTIN_MAP = new Map<string, BuiltinHandler>();
REGULAR_BUILTIN_MAP.set("eval", ({ ctx }, args, stdin) => handleEval(ctx, args, stdin));
REGULAR_BUILTIN_MAP.set("cd", ({ ctx }, args) => handleCd(ctx, args));
REGULAR_BUILTIN_MAP.set(":", () => OK);
REGULAR_BUILTIN_MAP.set("true", () => OK);
REGULAR_BUILTIN_MAP.set("false", () => testResult(false));
REGULAR_BUILTIN_MAP.set("let", ({ ctx }, args) => handleLet(ctx, args));
REGULAR_BUILTIN_MAP.set("command", (dispatchCtx, args, stdin) =>
  handleCommandBuiltin(dispatchCtx, args, stdin),
);
REGULAR_BUILTIN_MAP.set("builtin", (dispatchCtx, args, stdin) =>
  handleBuiltinBuiltin(dispatchCtx, args, stdin),
);
REGULAR_BUILTIN_MAP.set("alias", ({ ctx }, args) => handleAlias(ctx, args));
REGULAR_BUILTIN_MAP.set("unalias", ({ ctx }, args) => handleUnalias(ctx, args));
REGULAR_BUILTIN_MAP.set("shopt", ({ ctx }, args) => handleShopt(ctx, args));
REGULAR_BUILTIN_MAP.set("exec", ({ runCommand }, args, stdin) => {
  if (args.length === 0) return OK;
  const [cmd, ...rest] = args;
  return runCommand(cmd, rest, [], stdin, false, false, -1);
});
REGULAR_BUILTIN_MAP.set("wait", () => OK);
REGULAR_BUILTIN_MAP.set("type", ({ ctx }, args) =>
  handleTypeHelper(
    ctx,
    args,
    (name) => findFirstInPathHelper(ctx, name),
    (name) => findCommandInPathHelper(ctx, name),
  ),
);
REGULAR_BUILTIN_MAP.set("hash", ({ ctx }, args) => handleHash(ctx, args));
REGULAR_BUILTIN_MAP.set("help", ({ ctx }, args) => handleHelp(ctx, args));

/**
 * Dispatch a command to the appropriate builtin handler or external command.
 * Returns null if the command should be handled by external command resolution.
 */
export async function dispatchBuiltin(
  dispatchCtx: BuiltinDispatchContext,
  commandName: string,
  args: string[],
  _quotedArgs: boolean[],
  stdin: string,
  skipFunctions: boolean,
  _useDefaultPath: boolean,
  stdinSourceFd: number,
): Promise<ExecResult | null> {
  const { ctx, runCommand } = dispatchCtx;

  // Coverage tracking for builtins (lightweight: only fires when coverage is enabled)
  if (ctx.coverage && SHELL_BUILTINS.has(commandName)) {
    ctx.coverage.hit(`bash:builtin:${commandName}`);
  }

  // Special case: eval in POSIX mode is a special builtin (cannot be overridden by functions)
  if (commandName === "eval" && ctx.state.options.posix) {
    return handleEval(ctx, args, stdin);
  }

  // Check special builtins (cannot be overridden by functions)
  const specialHandler = SPECIAL_BUILTIN_MAP.get(commandName);
  if (specialHandler) {
    return specialHandler(dispatchCtx, args, stdin, stdinSourceFd);
  }

  // User-defined functions override regular builtins (except special ones above)
  if (!skipFunctions) {
    const func = ctx.state.functions.get(commandName);
    if (func) {
      return callFunction(ctx, func, args, stdin);
    }
  }

  // Check regular builtins (can be overridden by functions)
  const regularHandler = REGULAR_BUILTIN_MAP.get(commandName);
  if (regularHandler) {
    return regularHandler(dispatchCtx, args, stdin, stdinSourceFd);
  }

  // Test commands: [ and test
  // Note: [[ is NOT handled here because it's a keyword, not a command.
  if (commandName === "[" || commandName === "test") {
    let testArgs = args;
    if (commandName === "[") {
      if (args[args.length - 1] !== "]") {
        return failure("[: missing `]'\n", 2);
      }
      testArgs = args.slice(0, -1);
    }
    return evaluateTestArgs(ctx, testArgs);
  }

  // Return null to indicate command should be handled by external resolution
  return null;
}

/**
 * Handle the 'command' builtin
 */
async function handleCommandBuiltin(
  dispatchCtx: BuiltinDispatchContext,
  args: string[],
  stdin: string,
): Promise<ExecResult> {
  const { ctx, runCommand } = dispatchCtx;

  // command [-pVv] command [arg...] - run command, bypassing functions
  if (args.length === 0) {
    return OK;
  }
  // Parse options
  let useDefaultPath = false; // -p flag
  let verboseDescribe = false; // -V flag (like type)
  let showPath = false; // -v flag (show path/name)
  let cmdArgs = args;

  while (cmdArgs.length > 0 && cmdArgs[0].startsWith("-")) {
    const opt = cmdArgs[0];
    if (opt === "--") {
      cmdArgs = cmdArgs.slice(1);
      break;
    }
    // Handle combined options like -pv, -vV, etc.
    for (const char of opt.slice(1)) {
      if (char === "p") {
        useDefaultPath = true;
      } else if (char === "V") {
        verboseDescribe = true;
      } else if (char === "v") {
        showPath = true;
      }
    }
    cmdArgs = cmdArgs.slice(1);
  }

  if (cmdArgs.length === 0) {
    return OK;
  }

  // Handle -v and -V: describe commands without executing
  if (showPath || verboseDescribe) {
    return await handleCommandVHelper(ctx, cmdArgs, showPath, verboseDescribe);
  }

  // Run command without checking functions, but builtins are still available
  // Pass useDefaultPath to use /usr/bin:/bin instead of $PATH
  const [cmd, ...rest] = cmdArgs;
  return runCommand(cmd, rest, [], stdin, true, useDefaultPath, -1);
}

/**
 * Handle the 'builtin' builtin
 */
async function handleBuiltinBuiltin(
  dispatchCtx: BuiltinDispatchContext,
  args: string[],
  stdin: string,
): Promise<ExecResult> {
  const { runCommand } = dispatchCtx;

  // builtin command [arg...] - run builtin command
  if (args.length === 0) {
    return OK;
  }
  // Handle -- option terminator
  let cmdArgs = args;
  if (cmdArgs[0] === "--") {
    cmdArgs = cmdArgs.slice(1);
    if (cmdArgs.length === 0) {
      return OK;
    }
  }
  const cmd = cmdArgs[0];
  // Check if the command is a shell builtin
  if (!SHELL_BUILTINS.has(cmd)) {
    // Not a builtin - return error
    return failure(`bash: builtin: ${cmd}: not a shell builtin\n`);
  }
  const [, ...rest] = cmdArgs;
  // Run as builtin (recursive call, skip function lookup)
  return runCommand(cmd, rest, [], stdin, true, false, -1);
}

/**
 * Handle external command resolution and execution.
 * Called when dispatchBuiltin returns null.
 */
export async function executeExternalCommand(
  dispatchCtx: BuiltinDispatchContext,
  commandName: string,
  args: string[],
  stdin: string,
  useDefaultPath: boolean,
): Promise<ExecResult> {
  const { ctx, buildExportedEnv, executeUserScript } = dispatchCtx;

  // External commands - resolve via PATH
  // For command -p, use default PATH /usr/bin:/bin instead of $PATH
  const defaultPath = "/usr/bin:/bin";
  const resolved = await resolveCommandHelper(
    ctx,
    commandName,
    useDefaultPath ? defaultPath : undefined,
  );
  if (!resolved) {
    // Try custom command-not-found handler if provided
    if (ctx.onCommandNotFound) {
      const result = await ctx.onCommandNotFound(commandName, args);
      if (result) return result;
    }

    // Check if this is a browser-excluded command for a more helpful error
    if (isBrowserExcludedCommand(commandName)) {
      const suggestFlag =
        commandName === "python" || commandName === "python3"
          ? " (Enable with --python)"
          : commandName === "sqlite3"
            ? " (Enable with --sqlite3)"
            : "";
      return failure(
        `bash: ${commandName}: command not available in browser environments.${suggestFlag} ` +
          `Exclude '${commandName}' from your commands or use the Node.js bundle.\n`,
        127,
      );
    }
    return failure(`bash: ${commandName}: command not found\n`, 127);
  }
  // Handle error cases from resolveCommand
  if ("error" in resolved) {
    if (resolved.error === "permission_denied") {
      return failure(`bash: ${commandName}: Permission denied\n`, 126);
    }
    // not_found error
    return failure(`bash: ${commandName}: No such file or directory\n`, 127);
  }
  // Handle user scripts (executable files without registered command handlers)
  if ("script" in resolved) {
    // Add to hash table for PATH caching (only for non-path commands)
    if (!commandName.includes("/")) {
      if (!ctx.state.hashTable) {
        ctx.state.hashTable = new Map();
      }
      ctx.state.hashTable.set(commandName, resolved.path);
    }
    return await executeUserScript(resolved.path, args, stdin);
  }
  const { cmd, path: cmdPath } = resolved;
  // Add to hash table for PATH caching (only for non-path commands)
  if (!commandName.includes("/")) {
    if (!ctx.state.hashTable) {
      ctx.state.hashTable = new Map();
    }
    ctx.state.hashTable.set(commandName, cmdPath);
  }

  // Use groupStdin as fallback if no stdin from redirections/pipeline
  // This is needed for commands inside groups/functions that receive stdin via heredoc
  const effectiveStdin = stdin || ctx.state.groupStdin || "";

  // Build exported environment for commands that need it (printenv, env, etc.)
  // Most builtins need access to the full env to modify state
  const exportedEnv = buildExportedEnv();

  const cmdCtx: CommandContext = {
    fs: ctx.fs,
    cwd: ctx.state.cwd,
    env: ctx.state.env,
    exportedEnv,
    stdin: effectiveStdin,
    limits: ctx.limits,
    exec: ctx.execFn,
    fetch: ctx.fetch,
    getRegisteredCommands: () => Array.from(ctx.commands.keys()),
    sleep: ctx.sleep,
    trace: ctx.trace,
    fileDescriptors: ctx.state.fileDescriptors,
    xpgEcho: ctx.state.shoptOptions.xpg_echo,
    coverage: ctx.coverage,
    signal: ctx.state.signal,
    requireDefenseContext: ctx.requireDefenseContext,
    jsBootstrapCode: ctx.jsBootstrapCode,
    sessionId: ctx.state.sessionId,
    bash: ctx.bash,
  };
  const guardedCmdCtx = createDefenseAwareCommandContext(cmdCtx, commandName);

  try {
    const runCommand = (): Promise<ExecResult> =>
      awaitWithDefenseContext(
        ctx.requireDefenseContext,
        "command",
        `${commandName} execution`,
        () => cmd.execute(args, guardedCmdCtx),
      );

    if (cmd.trusted) {
      // Trusted host-extension commands may opt in to unrestricted globals.
      return await DefenseInDepthBox.runTrustedAsync(() => runCommand());
    }
    return await runCommand();
  } catch (error) {
    // ExecutionLimitError must propagate - these are safety limits
    if (error instanceof ExecutionLimitError) {
      throw error;
    }
    // Security violations must propagate to top-level error handling
    if (error instanceof SecurityViolationError) {
      throw error;
    }
    return failure(
      `${commandName}: ${sanitizeErrorMessage(getErrorMessage(error))}\n`,
    );
  }
}
