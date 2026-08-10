/**
 * Pipeline Execution
 *
 * Handles execution of command pipelines (cmd1 | cmd2 | cmd3).
 */

import type { CommandNode, PipelineNode, WordNode } from "../ast/types.js";
import { _performanceNow } from "../security/trusted-globals.js";
import type { ExecResult, Observation } from "../types.js";
import { BadSubstitutionError, ErrexitError, ExitError } from "./errors.js";
import { OK } from "./helpers/result.js";
import type { InterpreterContext } from "./types.js";

/**
 * Type for executeCommand callback
 */
export type ExecuteCommandFn = (
  node: CommandNode,
  stdin: string,
) => Promise<ExecResult>;

/** Extracts the literal string value from a WordNode, or null if it contains expansions. */
function getLiteralValue(word: WordNode): string | null {
  if (word.parts.length === 0) return "";
  if (word.parts.length === 1) {
    const part = word.parts[0];
    if (part.type === "Literal") return part.value;
    if (part.type === "SingleQuoted") return part.value;
  }
  return null;
}

/**
 * Detect the line limit of a command that only consumes a fixed number of input lines.
 * Returns the line count, or null if the command is not a recognized line-limited consumer.
 * Recognizes: head -N, head -n N, head -n=N, head --lines N, head --lines=N.
 */
function getLineLimit(command: CommandNode): number | null {
  if (command.type !== "SimpleCommand" || !command.name) return null;

  const name = getLiteralValue(command.name);
  if (name !== "head") return null;

  const args = command.args;
  if (args.length === 0) return 10;

  for (let i = 0; i < args.length; i++) {
    const val = getLiteralValue(args[i]);
    if (val === null) continue;

    const dashNum = /^-(\d+)$/.exec(val);
    if (dashNum) return Number.parseInt(dashNum[1], 10);

    const dashNNum = /^-n(\d+)$/.exec(val);
    if (dashNNum) return Number.parseInt(dashNNum[1], 10);

    const dashNEqNum = /^-n=(\d+)$/.exec(val);
    if (dashNEqNum) return Number.parseInt(dashNEqNum[1], 10);

    const linesEqNum = /^--lines=(\d+)$/.exec(val);
    if (linesEqNum) return Number.parseInt(linesEqNum[1], 10);

    if ((val === "-n" || val === "--lines") && i + 1 < args.length) {
      const nextVal = getLiteralValue(args[i + 1]);
      if (nextVal !== null && /^\d+$/.test(nextVal)) {
        return Number.parseInt(nextVal, 10);
      }
    }
  }

  return null;
}

/**
 * Detect the match limit for a grep command with -m N or --max-count=N.
 * Returns the match count limit, or null if no limit is specified.
 * When the upstream has produced N matches, we can signal early termination.
 */
function getMatchLimit(command: CommandNode): number | null {
  if (command.type !== "SimpleCommand" || !command.name) return null;

  const name = getLiteralValue(command.name);
  if (name !== "grep" && name !== "egrep" && name !== "fgrep") return null;

  const args = command.args;
  for (let i = 0; i < args.length; i++) {
    const val = getLiteralValue(args[i]);
    if (val === null) continue;

    // --max-count=N
    const maxCountEq = /^--max-count=(\d+)$/.exec(val);
    if (maxCountEq) return Number.parseInt(maxCountEq[1], 10);

    // -mN (combined flag and value)
    const dashMNum = /^-m(\d+)$/.exec(val);
    if (dashMNum) return Number.parseInt(dashMNum[1], 10);

    // -m N or --max-count N (separate argument)
    if ((val === "-m" || val === "--max-count") && i + 1 < args.length) {
      const nextVal = getLiteralValue(args[i + 1]);
      if (nextVal !== null && /^\d+$/.test(nextVal)) {
        return Number.parseInt(nextVal, 10);
      }
    }
  }

  return null;
}

/**
 * Detect if a command is `wc -l` (line count only mode).
 * Returns true when wc is invoked with only the -l flag,
 * allowing a streaming counter optimization instead of buffering all input.
 */
function isLineCountOnly(command: CommandNode): boolean {
  if (command.type !== "SimpleCommand" || !command.name) return false;

  const name = getLiteralValue(command.name);
  if (name !== "wc") return false;

  const args = command.args;
  let hasLFlag = false;
  let hasFileArgs = false;

  for (let i = 0; i < args.length; i++) {
    const val = getLiteralValue(args[i]);
    if (val === null) return false; // Dynamic expansion — bail

    if (val === "-l" || val === "--lines") {
      hasLFlag = true;
    } else if (val.startsWith("-")) {
      // Any other flag (e.g., -w, -c, -m) disqualifies the optimization
      return false;
    } else {
      // Non-flag argument means it reads from a file, not stdin
      hasFileArgs = true;
    }
  }

  // Only optimize when reading from stdin (piped input) with only -l
  return hasLFlag && !hasFileArgs;
}

/**
 * Detect the tail line limit for a tail command.
 * Recognizes: tail -N, tail -n N, tail -n=N, tail --lines N, tail --lines=N.
 * Returns the line count, or null if the command is not a recognized tail consumer.
 * Optimization: only keep last N lines in a ring buffer instead of storing all input.
 */
function getTailLimit(command: CommandNode): number | null {
  if (command.type !== "SimpleCommand" || !command.name) return null;

  const name = getLiteralValue(command.name);
  if (name !== "tail") return null;

  const args = command.args;
  // Check for file arguments or +N (from-start) mode which we cannot optimize
  for (let i = 0; i < args.length; i++) {
    const val = getLiteralValue(args[i]);
    if (val === null) continue;

    // +N means "start from line N" — not optimizable with ring buffer
    if (/^\+\d+$/.test(val)) return null;

    // -f or --follow means "keep reading" — not optimizable
    if (val === "-f" || val === "--follow") return null;

    // Non-flag, non-numeric argument is a file — skip optimization
    if (!val.startsWith("-") && !/^\d+$/.test(val)) return null;
  }

  if (args.length === 0) return 10;

  for (let i = 0; i < args.length; i++) {
    const val = getLiteralValue(args[i]);
    if (val === null) continue;

    const dashNum = /^-(\d+)$/.exec(val);
    if (dashNum) return Number.parseInt(dashNum[1], 10);

    const dashNNum = /^-n(\d+)$/.exec(val);
    if (dashNNum) return Number.parseInt(dashNNum[1], 10);

    const dashNEqNum = /^-n=(\d+)$/.exec(val);
    if (dashNEqNum) return Number.parseInt(dashNEqNum[1], 10);

    const linesEqNum = /^--lines=(\d+)$/.exec(val);
    if (linesEqNum) return Number.parseInt(linesEqNum[1], 10);

    if ((val === "-n" || val === "--lines") && i + 1 < args.length) {
      const nextVal = getLiteralValue(args[i + 1]);
      if (nextVal !== null && /^\d+$/.test(nextVal)) {
        return Number.parseInt(nextVal, 10);
      }
    }
  }

  return null;
}

/**
 * Commands that inherently do NOT read from stdin.
 * Used to avoid short-circuiting commands that generate their own output.
 */
const STDIN_INDEPENDENT_COMMANDS: ReadonlySet<string> = new Set([
  "echo",
  "printf",
  "date",
  "pwd",
  "whoami",
  "hostname",
  "uname",
  "true",
  "false",
  "seq",
  "env",
  "export",
  "set",
  "unset",
  "alias",
  "type",
  "which",
  "basename",
  "dirname",
  "realpath",
  "sleep",
  "kill",
  "test",
  "[",
  "[[",
  "declare",
  "local",
  "readonly",
  "typeset",
  "let",
  "expr",
]);

/**
 * Determine if a command reads from stdin (and thus can be short-circuited
 * when stdin is empty).
 * Returns true if the command reads stdin, false if it generates its own output.
 */
function readsFromStdin(command: CommandNode): boolean {
  if (command.type !== "SimpleCommand" || !command.name) return false;

  const name = getLiteralValue(command.name);
  if (name === null) return true; // Unknown command — assume it reads stdin

  if (STDIN_INDEPENDENT_COMMANDS.has(name)) return false;

  // Commands with file arguments do not read from stdin
  const fileReadingCommands = new Set([
    "cat", "grep", "egrep", "fgrep", "wc", "sort", "uniq",
    "head", "tail", "cut", "awk", "sed",
  ]);
  if (fileReadingCommands.has(name)) {
    // Check if any non-flag argument is present (file argument)
    const args = command.args;
    for (let i = 0; i < args.length; i++) {
      const val = getLiteralValue(args[i]);
      if (val === null) return true; // Dynamic — assume reads stdin
      if (!val.startsWith("-") && val !== "") {
        // Has a file argument — does not read from stdin pipe
        return false;
      }
    }
    // No file arguments — reads from stdin
    return true;
  }

  return true;
}

/**
 * Truncate piped text to only the last N lines (ring buffer style).
 * Used to optimize upstream output when the next stage is `tail -N`.
 * We keep extra lines as a buffer since upstream may still be producing.
 */
function truncateToLastLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return "";

  // Count total lines
  let lineCount = 0;
  let idx = 0;
  while (idx < text.length) {
    const nl = text.indexOf("\n", idx);
    if (nl === -1) break;
    lineCount++;
    idx = nl + 1;
  }
  // Account for trailing content without newline
  if (idx < text.length) lineCount++;

  if (lineCount <= maxLines) return text;

  // Skip (lineCount - maxLines) lines from the beginning
  const linesToSkip = lineCount - maxLines;
  let skipIdx = 0;
  for (let skipped = 0; skipped < linesToSkip; skipped++) {
    const nl = text.indexOf("\n", skipIdx);
    if (nl === -1) break;
    skipIdx = nl + 1;
  }

  return text.slice(skipIdx);
}

/**
 * Count the number of newline characters in a string.
 * Used for the streaming wc -l optimization.
 */
function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

/** Truncate text to at most maxLines newline-delimited lines. */
function truncateToLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return "";
  let count = 0;
  let idx = 0;
  while (count < maxLines && idx < text.length) {
    const nl = text.indexOf("\n", idx);
    if (nl === -1) break;
    count++;
    idx = nl + 1;
  }
  if (count < maxLines) return text;
  return text.slice(0, idx);
}

/**
 * Execute a pipeline node (command or sequence of piped commands).
 */
export async function executePipeline(
  ctx: InterpreterContext,
  node: PipelineNode,
  executeCommand: ExecuteCommandFn,
): Promise<ExecResult> {
  // Record start time for timed pipelines
  const startTime = node.timed ? _performanceNow() : 0;

  let stdin = "";
  let lastResult: ExecResult = OK;
  let pipefailExitCode = 0; // Track rightmost failing command
  const pipestatusExitCodes: number[] = []; // Track all exit codes for PIPESTATUS
  let accumulatedStderr = ""; // Accumulate stderr from all pipeline commands
  const allObservations: Observation[] = [];

  // For multi-command pipelines, save parent's $_ because pipeline commands
  // run in subshell-like contexts and should not affect parent's $_
  // (except the last command when lastpipe is enabled)
  const isMultiCommandPipeline = node.commands.length > 1;
  const savedLastArg = ctx.state.lastArg;

  for (let i = 0; i < node.commands.length; i++) {
    const command = node.commands[i];
    const isLast = i === node.commands.length - 1;
    const isFirst = i === 0;

    // In a multi-command pipeline, each command runs in a subshell context
    // where $_ starts empty (subshells don't inherit $_ from parent in same way)
    if (isMultiCommandPipeline) {
      // Clear $_ for each pipeline command - they each get fresh subshell context
      ctx.state.lastArg = "";

      // After the first command, clear groupStdin so subsequent commands
      // only see stdin from the pipeline (even if empty), not the original groupStdin
      // This prevents commands like head from incorrectly falling back to groupStdin
      // when they receive empty output from a previous command (e.g., grep with no matches)
      if (!isFirst) {
        ctx.state.groupStdin = undefined;
      }
    }

    // Determine if this command runs in a subshell context
    // In bash, all commands except the last run in subshells
    // With lastpipe enabled, the last command runs in the current shell
    const runsInSubshell =
      isMultiCommandPipeline && (!isLast || !ctx.state.shoptOptions.lastpipe);

    // Save environment for commands running in subshell context
    // This prevents variable assignments (e.g., ${cmd=echo}) from leaking to parent
    const savedEnv = runsInSubshell ? new Map(ctx.state.env) : null;

    let result: ExecResult;
    try {
      result = await executeCommand(command, stdin);
    } catch (error) {
      // BadSubstitutionError should fail the command but not abort the script
      if (error instanceof BadSubstitutionError) {
        result = {
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: 1,
          observations: error.observations,
        };
      }
      // In a MULTI-command pipeline, each command runs in a subshell context
      // So exit/return/errexit only affect that segment, not the whole script
      // For single commands, let these errors propagate to terminate the script
      else if (error instanceof ExitError && node.commands.length > 1) {
        result = {
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode,
          observations: error.observations,
        };
      } else if (error instanceof ErrexitError && node.commands.length > 1) {
        // Errexit inside a pipeline segment should only fail that segment
        // The pipeline's exit code comes from the last command (or pipefail)
        result = {
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode,
          observations: error.observations,
        };
      } else {
        // Restore environment before re-throwing
        if (savedEnv) {
          ctx.state.env = savedEnv;
        }
        throw error;
      }
    }

    // Restore environment for subshell commands to prevent variable assignment leakage
    if (savedEnv) {
      ctx.state.env = savedEnv;
    }

    // Track exit code for PIPESTATUS
    pipestatusExitCodes.push(result.exitCode);

    // Track the exit code of failing commands for pipefail
    if (result.exitCode !== 0) {
      pipefailExitCode = result.exitCode;
    }

    if (result.observations) {
      allObservations.push(...result.observations);
    }

    if (!isLast) {
      // Check if this pipe is |& (pipe stderr to next command's stdin too)
      const pipeStderrToNext = node.pipeStderr?.[i] ?? false;
      if (pipeStderrToNext) {
        // |& pipes both stdout and stderr to next command's stdin
        stdin = result.stderr + result.stdout;
      } else {
        // Regular | only pipes stdout; stderr goes to the parent
        stdin = result.stdout;
        accumulatedStderr += result.stderr;
      }

      const nextCommand = node.commands[i + 1];

      // --- Pipeline optimizations (zero-cost: null checks only when not triggered) ---

      // Early termination: if the next command only needs N lines, truncate
      // the piped output to avoid processing unnecessary data downstream.
      const nextLineLimit = getLineLimit(nextCommand);
      if (nextLineLimit !== null) {
        stdin = truncateToLines(stdin, nextLineLimit + 10);
      }

      // grep -m N early exit: truncate upstream to N matching lines worth of input.
      // Since grep filters lines, we provide extra input headroom (N * 10 lines)
      // to increase the chance grep finds its N matches.
      const nextMatchLimit = getMatchLimit(nextCommand);
      if (nextMatchLimit !== null) {
        stdin = truncateToLines(stdin, nextMatchLimit * 10);
      }

      // tail -N skip optimization: only retain the last N+10 lines
      // (with buffer) so that upstream data beyond what tail needs is discarded.
      const nextTailLimit = getTailLimit(nextCommand);
      if (nextTailLimit !== null) {
        stdin = truncateToLastLines(stdin, nextTailLimit + 10);
      }

      // wc -l streaming counter optimization: if the next command is `wc -l`,
      // count newlines now and replace stdin with just the count output.
      // This avoids passing the full text through the wc command execution.
      if (isLineCountOnly(nextCommand)) {
        const lineCount = countNewlines(stdin);
        // Skip executing wc -l by providing the result directly.
        // We synthesize the result and advance past the next command.
        const wcResult: ExecResult = {
          stdout: `${lineCount}\n`,
          stderr: "",
          exitCode: 0,
        };
        pipestatusExitCodes.push(wcResult.exitCode);
        i++; // Skip the wc -l command
        const wcIsLast = i === node.commands.length - 1;
        if (!wcIsLast) {
          stdin = wcResult.stdout;
          lastResult = {
            stdout: "",
            stderr: "",
            exitCode: wcResult.exitCode,
          };
        } else {
          lastResult = wcResult;
        }
        continue;
      }

      // Empty stdin short-circuit: if the previous stage produced empty output
      // and the next command reads from stdin, skip execution entirely.
      if (stdin === "" && readsFromStdin(nextCommand)) {
        // Synthesize an empty result — the command would produce nothing anyway.
        const emptyResult: ExecResult = {
          stdout: "",
          stderr: "",
          exitCode: 0,
        };
        pipestatusExitCodes.push(emptyResult.exitCode);
        i++; // Skip the next command
        const skipIsLast = i === node.commands.length - 1;
        if (!skipIsLast) {
          stdin = "";
          lastResult = {
            stdout: "",
            stderr: "",
            exitCode: emptyResult.exitCode,
          };
        } else {
          lastResult = emptyResult;
        }
        continue;
      }

      lastResult = {
        stdout: "",
        stderr: "",
        exitCode: result.exitCode,
      };
    } else {
      lastResult = result;
    }
  }

  // Merge stderr from all non-last pipeline commands into the final result.
  // In bash, stderr from each pipeline command goes to the terminal (parent),
  // not through the pipe. Only stdout flows through pipes.
  if (accumulatedStderr) {
    lastResult = {
      ...lastResult,
      stderr: accumulatedStderr + lastResult.stderr,
    };
  }

  // Set PIPESTATUS array with exit codes from all pipeline commands
  // For single-command pipelines with compound commands, don't set PIPESTATUS here -
  // let inner statements set it (e.g., non-matching case statements should leave
  // PIPESTATUS unchanged, matching bash behavior).
  // For multi-command pipelines or simple commands, always set PIPESTATUS.
  const shouldSetPipestatus =
    node.commands.length > 1 ||
    (node.commands.length === 1 && node.commands[0].type === "SimpleCommand");

  if (shouldSetPipestatus) {
    // Clear any previous PIPESTATUS entries
    for (const key of ctx.state.env.keys()) {
      if (key.startsWith("PIPESTATUS_")) {
        ctx.state.env.delete(key);
      }
    }
    // Set new PIPESTATUS entries
    for (let i = 0; i < pipestatusExitCodes.length; i++) {
      ctx.state.env.set(`PIPESTATUS_${i}`, String(pipestatusExitCodes[i]));
    }
    ctx.state.env.set("PIPESTATUS__length", String(pipestatusExitCodes.length));
  }

  // If pipefail is enabled, use the rightmost failing exit code
  if (ctx.state.options.pipefail && pipefailExitCode !== 0) {
    lastResult = {
      ...lastResult,
      exitCode: pipefailExitCode,
    };
  }

  if (node.negated) {
    lastResult = {
      ...lastResult,
      exitCode: lastResult.exitCode === 0 ? 1 : 0,
    };
  }

  // Output timing info for timed pipelines
  if (node.timed) {
    const endTime = _performanceNow();
    const elapsedSeconds = (endTime - startTime) / 1000;
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;

    let timingOutput: string;
    if (node.timePosix) {
      // POSIX format (-p): decimal format without leading zeros
      timingOutput = `real ${elapsedSeconds.toFixed(2)}\nuser 0.00\nsys 0.00\n`;
    } else {
      // Default bash format: real/user/sys with XmY.YYYs
      const realStr = `${minutes}m${seconds.toFixed(3)}s`;
      timingOutput = `\nreal\t${realStr}\nuser\t0m0.000s\nsys\t0m0.000s\n`;
    }

    lastResult = {
      ...lastResult,
      stderr: lastResult.stderr + timingOutput,
    };
  }

  // Handle $_ for multi-command pipelines:
  // - With lastpipe enabled: $_ is set by the last command (already done above)
  // - Without lastpipe: $_ should be restored to the value before the pipeline
  //   (since all commands ran in subshells that don't affect parent's $_)
  if (isMultiCommandPipeline && !ctx.state.shoptOptions.lastpipe) {
    ctx.state.lastArg = savedLastArg;
  }
  // With lastpipe, the last command already updated $_ in the main shell context

  // Attach all observations collected across the pipeline
  if (allObservations.length > 0) {
    lastResult = {
      ...lastResult,
      observations: [...(lastResult.observations || []), ...allObservations],
    };
  }

  return lastResult;
}
