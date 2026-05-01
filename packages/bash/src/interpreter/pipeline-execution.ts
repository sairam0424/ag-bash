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

      // Early termination: if the next command only needs N lines, truncate
      // the piped output to avoid processing unnecessary data downstream.
      const nextLineLimit = getLineLimit(node.commands[i + 1]);
      if (nextLineLimit !== null) {
        stdin = truncateToLines(stdin, nextLineLimit + 10);
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
