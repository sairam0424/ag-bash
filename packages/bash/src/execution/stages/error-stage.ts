/**
 * ErrorStage - Error categorization and ExecResult construction.
 *
 * This is not a normal pipeline stage but a utility used by the pipeline
 * runner to convert thrown errors into structured BashExecResult objects.
 * It categorizes errors by type and assigns appropriate exit codes.
 */

import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import { mapToRecordWithExtras } from "../../helpers/env.js";
import {
  ArithmeticError,
  ExecutionAbortedError,
  ExecutionLimitError,
  ExitError,
  PosixFatalError,
} from "../../interpreter/errors.js";
import type { InterpreterState } from "../../interpreter/types.js";
import { LexerError } from "../../parser/lexer.js";
import type { ParseException } from "../../parser/parser.js";
import { AgTrace } from "../../observability/ag-trace.js";
import {
  SecurityViolationError,
} from "../../security/defense-in-depth-box.js";
import type { BashExecResult } from "../../types.js";

/**
 * Convert a caught error into a structured BashExecResult.
 * Returns undefined if the error is not recognized (should be re-thrown).
 */
export function categorizeError(
  error: unknown,
  state: InterpreterState,
  optionsEnv: Record<string, string> | undefined,
): BashExecResult | undefined {
  const env = mapToRecordWithExtras(state.env, optionsEnv);

  // ExitError propagates from 'exit' builtin (including via eval/source)
  if (error instanceof ExitError || (error instanceof Error && error.name === "ExitError")) {
    const exitErr = error as ExitError;
    return {
      stdout: exitErr.stdout,
      stderr: exitErr.stderr,
      exitCode: exitErr.exitCode,
      env,
      observations: [AgTrace.analyzeError(exitErr)],
    };
  }

  // PosixFatalError propagates from special builtins in POSIX mode
  if (error instanceof PosixFatalError) {
    return {
      stdout: error.stdout,
      stderr: error.stderr,
      exitCode: error.exitCode,
      env,
      observations: [AgTrace.analyzeError(error)],
    };
  }

  if (error instanceof ArithmeticError) {
    return {
      stdout: error.stdout,
      stderr: error.stderr,
      exitCode: 1,
      env,
      observations: [AgTrace.analyzeError(error)],
    };
  }

  // ExecutionAbortedError is thrown when an AbortSignal fires (timeout cancellation)
  if (error instanceof ExecutionAbortedError) {
    return {
      stdout: error.stdout,
      stderr: error.stderr,
      exitCode: 124, // Same as timeout exit code
      env,
      observations: [AgTrace.analyzeError(error)],
    };
  }

  // SecurityViolationError is thrown when defense-in-depth detects a blocked operation
  const errorName = error instanceof Error ? error.name : "";
  if (
    error instanceof SecurityViolationError ||
    errorName === "SecurityViolationError"
  ) {
    return {
      stdout: "",
      stderr: `bash: security violation: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}\n`,
      exitCode: 1,
      env,
      observations: [AgTrace.analyzeError(error as Error)],
    };
  }

  // ExecutionLimitError is thrown when command limits are exceeded during interpreter loop
  if (
    error instanceof ExecutionLimitError ||
    errorName === "ExecutionLimitError"
  ) {
    return {
      stdout: "",
      stderr: `bash: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}\n`,
      exitCode: ExecutionLimitError.EXIT_CODE,
      env,
      observations: [AgTrace.analyzeError(error as Error)],
    };
  }

  if ((error as ParseException)?.name === "ParseException") {
    return {
      stdout: "",
      stderr: `bash: syntax error: ${sanitizeErrorMessage((error as Error).message)}\n`,
      exitCode: 2,
      env,
      observations: [AgTrace.analyzeError(error as Error)],
    };
  }

  // LexerError is thrown for lexer-level issues like unterminated quotes
  if (error instanceof LexerError) {
    return {
      stdout: "",
      stderr: `bash: ${sanitizeErrorMessage(error.message)}\n`,
      exitCode: 2,
      env,
      observations: [AgTrace.analyzeError(error)],
    };
  }

  // RangeError occurs when JavaScript call stack is exceeded (deep recursion)
  if (error instanceof RangeError) {
    return {
      stdout: "",
      stderr: `bash: ${sanitizeErrorMessage(error.message)}\n`,
      exitCode: 1,
      env,
      observations: [AgTrace.analyzeError(error)],
    };
  }

  // Unrecognized error - return undefined to signal re-throw
  return undefined;
}
