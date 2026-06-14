/**
 * Result Helper Utilities
 *
 * Convenience factories for creating ExecResult objects in custom commands.
 * Eliminates boilerplate when returning success/failure from command handlers.
 */

import type { ExecResult } from "../types.js";

/**
 * Create a successful ExecResult (exitCode 0).
 *
 * @example
 * ```ts
 * return success("Hello, world!\n");
 * ```
 */
export function success(stdout: string = ""): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

/**
 * Create a failed ExecResult with an error message.
 *
 * @example
 * ```ts
 * return fail("mycommand: file not found\n", 2);
 * ```
 */
export function fail(stderr: string, exitCode: number = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

/**
 * Create an ExecResult with explicit stdout, stderr, and exitCode.
 *
 * @example
 * ```ts
 * return output("partial data\n", "warning: truncated\n", 0);
 * ```
 */
export function output(
  stdout: string,
  stderr: string,
  exitCode: number,
): ExecResult {
  return { stdout, stderr, exitCode };
}
