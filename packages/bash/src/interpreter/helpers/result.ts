/**
 * ExecResult factory functions for cleaner code.
 *
 * These helpers reduce verbosity and improve readability when
 * constructing ExecResult objects throughout the interpreter.
 */

import type { ExecResult, Observation } from "../../types.js";
import { ExecutionLimitError } from "../errors.js";
import type { InterpreterContext } from "../types.js";

/**
 * A successful result with no output.
 * Use this for commands that succeed silently.
 */
export const OK: ExecResult = Object.freeze({
  stdout: "",
  stderr: "",
  exitCode: 0,
});

/**
 * Create a successful result with optional stdout.
 *
 * @param stdout - Output to include (default: "")
 * @param observations - Optional failure metadata
 * @returns ExecResult with exitCode 0
 */
export function success(stdout = "", observations?: Observation[]): ExecResult {
  return { stdout, stderr: "", exitCode: 0, observations };
}

/**
 * Create a failure result with stderr message.
 *
 * @param stderr - Error message to include
 * @param exitCode - Exit code (default: 1)
 * @param observations - Optional failure metadata
 * @returns ExecResult with the specified exitCode
 */
export function failure(
  stderr: string,
  exitCode = 1,
  observations?: Observation[],
): ExecResult {
  return { stdout: "", stderr, exitCode, observations };
}

/**
 * Create a result with all fields specified.
 *
 * @param stdout - Standard output
 * @param stderr - Standard error
 * @param exitCode - Exit code
 * @param observations - Optional failure metadata
 * @returns ExecResult with all fields
 */
export function result(
  stdout: string,
  stderr: string,
  exitCode: number,
  observations?: Observation[],
): ExecResult {
  return { stdout, stderr, exitCode, observations };
}

/**
 * Convert a boolean test result to an ExecResult.
 * Useful for test/conditional commands where true = exit 0, false = exit 1.
 *
 * @param passed - Boolean test result
 * @returns ExecResult with exitCode 0 if passed, 1 otherwise
 */
export function testResult(passed: boolean): ExecResult {
  return { stdout: "", stderr: "", exitCode: passed ? 0 : 1 };
}

/**
 * Throw an ExecutionLimitError for execution limits (recursion, iterations, commands).
 *
 * @param message - Error message describing the limit exceeded
 * @param limitType - Type of limit exceeded
 * @param stdout - Accumulated stdout to include
 * @param stderr - Accumulated stderr to include
 * @throws ExecutionLimitError always
 */
export function throwExecutionLimit(
  message: string,
  limitType:
    | "recursion"
    | "iterations"
    | "commands"
    | "string_length"
    | "glob_operations"
    | "substitution_depth"
    | "output_size"
    | "file_descriptors"
    | "memory"
    | "cpu_time"
    | "network_traffic"
    | "sub_agents",
  stdout = "",
  stderr = "",
): never {
  throw new ExecutionLimitError(message, limitType, stdout, stderr);
}

/**
 * Check file descriptor count against the limit before adding a new one.
 * Throws ExecutionLimitError if the limit would be exceeded.
 */
export function checkFdLimit(ctx: InterpreterContext): void {
  const fds = ctx.state.fileDescriptors;
  if (fds && fds.size >= ctx.limits.maxFileDescriptors) {
    throw new ExecutionLimitError(
      `too many open file descriptors (max ${ctx.limits.maxFileDescriptors})`,
      "file_descriptors",
    );
  }
}

/**
 * Stable machine-readable codes for source-emitted observations.
 * These are deliberately POSIX/errno-flavored so agents can switch on a
 * stable identifier instead of parsing English stderr.
 */
export interface ObservationCodes {
  readonly COMMAND_NOT_FOUND: "CMD_NOT_FOUND";
  readonly FILE_NOT_FOUND: "ENOENT";
  readonly DIRECTORY_NOT_FOUND: "ENOENT_DIR";
  readonly PERMISSION_DENIED: "EACCES";
  readonly IS_A_DIRECTORY: "EISDIR";
  readonly NOT_A_DIRECTORY: "ENOTDIR";
  readonly LIMIT_EXCEEDED: "ELIMIT";
  readonly SECURITY_VIOLATION: "ESEC";
  readonly SYNTAX_ERROR: "ESYNTAX";
}

export const OBSERVATION_CODES: ObservationCodes = Object.freeze({
  COMMAND_NOT_FOUND: "CMD_NOT_FOUND",
  FILE_NOT_FOUND: "ENOENT",
  DIRECTORY_NOT_FOUND: "ENOENT_DIR",
  PERMISSION_DENIED: "EACCES",
  IS_A_DIRECTORY: "EISDIR",
  NOT_A_DIRECTORY: "ENOTDIR",
  LIMIT_EXCEEDED: "ELIMIT",
  SECURITY_VIOLATION: "ESEC",
  SYNTAX_ERROR: "ESYNTAX",
});

/**
 * Observation factory helpers.
 *
 * These produce well-formed, high-confidence {@link Observation} objects at
 * the SOURCE of a typed failure — where the interpreter/command actually KNOWS
 * the cause (command resolution, fs ops, permission checks) rather than where
 * AgTrace regex-scrapes English stderr after the fact.
 *
 * Every source-emitted observation carries:
 *  - a stable machine `code` (see {@link OBSERVATION_CODES})
 *  - a `confidence` of 1.0 (the source is authoritative about its own failure)
 *
 * All factories return frozen, immutable objects (new objects, never mutated).
 */
export const obs: {
  commandNotFound(command: string, suggestions?: string[]): Observation;
  fileNotFound(path: string, command?: string): Observation;
  directoryNotFound(path: string, command?: string): Observation;
  isADirectory(path: string, command?: string): Observation;
  notADirectory(path: string, command?: string): Observation;
  permissionDenied(path: string, command?: string): Observation;
} = Object.freeze({
  /**
   * Command name could not be resolved on PATH (exit 127).
   * @param command - The unresolved command name.
   * @param suggestions - Optional "did you mean" candidates.
   */
  commandNotFound(command: string, suggestions?: string[]): Observation {
    return Object.freeze({
      type: "command_not_found",
      code: OBSERVATION_CODES.COMMAND_NOT_FOUND,
      confidence: 1,
      message: `Command '${command}' not found.`,
      command,
      ...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
    });
  },

  /**
   * A file path did not exist when a command tried to read it.
   * @param path - The missing path (as the user referenced it).
   * @param command - The command that attempted the read.
   */
  fileNotFound(path: string, command?: string): Observation {
    return Object.freeze({
      type: "file_not_found",
      code: OBSERVATION_CODES.FILE_NOT_FOUND,
      confidence: 1,
      message: `File '${path}' not found.`,
      path,
      ...(command ? { command } : {}),
    });
  },

  /**
   * A directory path did not exist.
   * @param path - The missing directory path.
   * @param command - The command that attempted the operation.
   */
  directoryNotFound(path: string, command?: string): Observation {
    return Object.freeze({
      type: "directory_not_found",
      code: OBSERVATION_CODES.DIRECTORY_NOT_FOUND,
      confidence: 1,
      message: `Directory '${path}' not found.`,
      path,
      ...(command ? { command } : {}),
    });
  },

  /**
   * Expected a file but the path is a directory (EISDIR).
   * @param path - The path that is a directory.
   * @param command - The command that attempted the operation.
   */
  isADirectory(path: string, command?: string): Observation {
    return Object.freeze({
      type: "file_not_found",
      code: OBSERVATION_CODES.IS_A_DIRECTORY,
      confidence: 1,
      message: `'${path}' is a directory, not a file.`,
      path,
      ...(command ? { command } : {}),
    });
  },

  /**
   * A path component expected to be a directory is not (ENOTDIR).
   * @param path - The path that is not a directory.
   * @param command - The command that attempted the operation.
   */
  notADirectory(path: string, command?: string): Observation {
    return Object.freeze({
      type: "directory_not_found",
      code: OBSERVATION_CODES.NOT_A_DIRECTORY,
      confidence: 1,
      message: `'${path}' is not a directory.`,
      path,
      ...(command ? { command } : {}),
    });
  },

  /**
   * Access to a path was denied by the security policy or fs mode (exit 126).
   * @param path - The path that was denied.
   * @param command - The command that attempted the access.
   */
  permissionDenied(path: string, command?: string): Observation {
    return Object.freeze({
      type: "permission_denied",
      code: OBSERVATION_CODES.PERMISSION_DENIED,
      confidence: 1,
      message: `Permission denied for '${path}'.`,
      path,
      ...(command ? { command } : {}),
    });
  },
});
