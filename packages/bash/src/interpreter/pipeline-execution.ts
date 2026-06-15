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
 * Detect `grep -m N` match limit for early exit optimization.
 * Recognizes: grep -m N, grep --max-count=N, grep -N (numeric shorthand).
 * Returns the match count limit, or null if not detected.
 */
function getMatchLimit(command: CommandNode): number | null {
  if (command.type !== "SimpleCommand" || !command.name) return null;

  const name = getLiteralValue(command.name);
  if (name !== "grep" && name !== "egrep" && name !== "fgrep") return null;

  const args: string[] = [];
  for (const arg of command.args) {
    const val = getLiteralValue(arg);
    if (val !== null) args.push(val);
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-m" && i + 1 < args.length) {
      const n = parseInt(args[i + 1], 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }

    if (arg.startsWith("--max-count=")) {
      const n = parseInt(arg.slice(12), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }

    const match = /^-(\d+)$/.exec(arg);
    if (match) {
      const n = parseInt(match[1], 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
  }

  return null;
}

/**
 * Detect if a command is `wc -l` (line count only).
 * When detected, the pipeline can count newlines directly instead of
 * buffering and processing all input through wc.
 */
function isLineCountOnly(command: CommandNode): boolean {
  if (command.type !== "SimpleCommand" || !command.name) return false;

  const name = getLiteralValue(command.name);
  if (name !== "wc") return false;

  if (command.args.length !== 1) return false;

  const arg = getLiteralValue(command.args[0]);
  return arg === "-l";
}

/**
 * Detect `tail -N` line limit for ring buffer optimization.
 * Recognizes: tail -N, tail -n N, tail --lines=N.
 * Returns null if: +N (from start), -f (follow), or file arguments detected.
 */
function getTailLimit(command: CommandNode): number | null {
  if (command.type !== "SimpleCommand" || !command.name) return null;

  const name = getLiteralValue(command.name);
  if (name !== "tail") return null;

  const args: string[] = [];
  for (const arg of command.args) {
    const val = getLiteralValue(arg);
    if (val !== null) args.push(val);
  }

  // If -f or --follow is present, bail out (streaming mode)
  for (const arg of args) {
    if (arg === "-f" || arg === "--follow" || arg === "-F") return null;
  }

  let limit: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // tail -N (shorthand for last N lines)
    const dashNum = /^-(\d+)$/.exec(arg);
    if (dashNum) {
      limit = parseInt(dashNum[1], 10);
      continue;
    }

    // tail -nN (combined form)
    const dashNNum = /^-n(\d+)$/.exec(arg);
    if (dashNNum) {
      limit = parseInt(dashNNum[1], 10);
      continue;
    }

    // tail --lines=N
    const linesEq = /^--lines=(.+)$/.exec(arg);
    if (linesEq) {
      const val = linesEq[1];
      // +N means from start, not a tail limit optimization
      if (val.startsWith("+")) return null;
      const n = parseInt(val, 10);
      if (Number.isFinite(n) && n > 0) {
        limit = n;
      }
      continue;
    }

    // tail -n N (separate argument)
    if (arg === "-n" && i + 1 < args.length) {
      const nextVal = args[i + 1];
      // +N means from start
      if (nextVal.startsWith("+")) return null;
      const n = parseInt(nextVal, 10);
      if (Number.isFinite(n) && n > 0) {
        limit = n;
      }
      i++; // skip next arg
      continue;
    }

    // Detect file arguments (non-flag arguments indicate file input, not stdin)
    if (!arg.startsWith("-") && arg !== "") {
      return null;
    }
  }

  return limit !== null && limit > 0 ? limit : null;
}

/** Keep only the last N lines from text (ring buffer semantics for tail). */
function keepLastLines(text: string, n: number): string {
  if (n <= 0) return "";
  const lines = text.split("\n");
  // If text ends with \n, split produces an extra empty element
  const hasTrailingNewline = text.endsWith("\n");
  const contentLines = hasTrailingNewline ? lines.slice(0, -1) : lines;

  if (contentLines.length <= n) return text;

  const kept = contentLines.slice(-n);
  return hasTrailingNewline ? `${kept.join("\n")}\n` : kept.join("\n");
}

/**
 * Commands that do NOT read from stdin. When the previous pipeline stage
 * produced empty output and the next command is NOT in this set (and has no
 * file arguments), we can short-circuit with empty output.
 */
const STDIN_INDEPENDENT: ReadonlySet<string> = new Set([
  "echo",
  "printf",
  "date",
  "pwd",
  "true",
  "false",
  "hostname",
  "uname",
  "whoami",
  "env",
  "export",
]);

/**
 * Commands that READ stdin but still produce NON-empty output on empty input,
 * so they must NOT be short-circuited when upstream produced nothing. Hash/checksum
 * filters have a defined value for the empty string (e.g. MD5 of "" is
 * d41d8cd98f00b204e9800998ecf8427e), so `echo -n '' | md5sum` must actually run.
 */
const EMPTY_STDIN_PRODUCES_OUTPUT: ReadonlySet<string> = new Set([
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "cksum",
]);

/**
 * Detect if a command is stdin-independent (doesn't read from stdin).
 * Returns true if the command is in STDIN_INDEPENDENT or has file arguments.
 */
function isStdinIndependent(command: CommandNode): boolean {
  if (command.type !== "SimpleCommand" || !command.name) return false;

  const name = getLiteralValue(command.name);
  if (name === null) return false;

  if (STDIN_INDEPENDENT.has(name)) return true;

  // Commands with file arguments are also stdin-independent
  for (const arg of command.args) {
    const val = getLiteralValue(arg);
    if (val !== null && !val.startsWith("-") && val !== "") {
      // Has a positional argument that could be a file — considered stdin-independent
      return true;
    }
  }

  return false;
}

/**
 * True when the command, reading empty stdin with no file args, still emits
 * non-empty output (hash/checksum filters) and therefore must not be
 * short-circuited away.
 */
function producesOutputOnEmptyStdin(command: CommandNode): boolean {
  if (command.type !== "SimpleCommand" || !command.name) return false;
  const name = getLiteralValue(command.name);
  return name !== null && EMPTY_STDIN_PRODUCES_OUTPUT.has(name);
}

/** Count newlines in a string without creating intermediate arrays. */
function countNewlines(text: string): number {
  let count = 0;
  let idx = 0;
  while (idx < text.length) {
    const nl = text.indexOf("\n", idx);
    if (nl === -1) break;
    count++;
    idx = nl + 1;
  }
  return count;
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

    // Optimization B: wc -l streaming counter — count newlines directly
    // instead of executing the full wc command when only line count is needed.
    // Only applies to non-first commands in a pipeline (where stdin comes from pipe).
    const wcLineCountOptimized = !isFirst && isLineCountOnly(command);
    if (wcLineCountOptimized) {
      const lineCount = countNewlines(stdin);
      result = {
        stdout: `${lineCount}\n`,
        stderr: "",
        exitCode: 0,
      };
    } else {
      // Optimization D: Empty stdin short-circuit — when upstream produced
      // nothing and the command is a pure stdin-reading filter, skip execution
      // (an empty-input filter yields empty output and exit 0).
      //
      // Restricted to SimpleCommand: compound commands (Subshell, Group, and
      // control structures) run their body regardless of stdin, so their exit
      // code and output are NOT determined by empty input. Short-circuiting
      // them would fabricate exit 0 — e.g. `true | (false)` or the PIPESTATUS
      // restore `(exit 0) | (exit 1)` would wrongly report 0, dropping the
      // last stage's real exit code from $? and PIPESTATUS.
      const emptyStdinShortCircuit =
        !isFirst &&
        stdin === "" &&
        command.type === "SimpleCommand" &&
        !isStdinIndependent(command) &&
        // Hash/checksum filters emit a defined non-empty value for empty input,
        // so they must actually run rather than be short-circuited to "".
        !producesOutputOnEmptyStdin(command);

      if (emptyStdinShortCircuit) {
        result = {
          stdout: "",
          stderr: "",
          exitCode: 0,
        };
      } else {
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
          } else if (
            error instanceof ErrexitError &&
            node.commands.length > 1
          ) {
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

      // Early termination: if the next command only needs N lines, truncate
      // the piped output to avoid processing unnecessary data downstream.
      const nextLineLimit = getLineLimit(nextCommand);
      if (nextLineLimit !== null) {
        stdin = truncateToLines(stdin, nextLineLimit + 10);
      }

      // Optimization A: grep -m N early exit — provide headroom for filtering
      const nextMatchLimit = getMatchLimit(nextCommand);
      if (nextMatchLimit !== null) {
        stdin = truncateToLines(stdin, nextMatchLimit * 10);
      }

      // Optimization C: tail -N ring buffer — only keep last N lines
      const nextTailLimit = getTailLimit(nextCommand);
      if (nextTailLimit !== null) {
        stdin = keepLastLines(stdin, nextTailLimit);
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

  // Attach all observations collected across the pipeline.
  // `allObservations` already includes the last command's observations
  // (pushed during the loop above), so we must NOT concatenate
  // `lastResult.observations` again or single-command pipelines double-emit.
  if (allObservations.length > 0) {
    lastResult = {
      ...lastResult,
      observations: allObservations,
    };
  }

  return lastResult;
}
