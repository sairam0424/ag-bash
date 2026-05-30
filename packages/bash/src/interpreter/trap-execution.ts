/**
 * Trap Execution
 *
 * Executes registered trap handlers for shell signals/events.
 * Trap handlers execute in the current shell context (not a subshell).
 *
 * Supported signals:
 * - EXIT: Fires when script finishes (normal or via exit)
 * - ERR: Fires when a command fails (exitCode !== 0) outside conditions
 * - DEBUG: Fires before each simple command
 * - RETURN: Fires after a function or sourced script returns
 */

import { parse } from "../parser/parser.js";
import type { ExecResult } from "../types.js";
import type { InterpreterContext } from "./types.js";

/**
 * Execute a registered trap handler.
 * Traps execute in the current shell context (not a subshell).
 * Returns null if no handler is registered for the signal.
 *
 * @param ctx - The interpreter context
 * @param signal - The signal name (EXIT, ERR, DEBUG, RETURN)
 * @returns The execution result, or null if no handler registered
 */
export async function executeTrap(
  ctx: InterpreterContext,
  signal: string,
): Promise<ExecResult | null> {
  const handler = ctx.state.trapHandlers?.get(signal);
  if (handler === undefined) return null;

  // Empty handler means "ignore this signal"
  if (handler === "") return { stdout: "", stderr: "", exitCode: 0 };

  // Parse the handler command string into an AST
  try {
    const ast = parse(handler);
    return await ctx.executeScript(ast);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: "",
      stderr: `trap handler error: ${message}\n`,
      exitCode: 1,
    };
  }
}

/**
 * Execute the ERR trap if conditions are met.
 * ERR trap fires when a command fails (exitCode !== 0) and:
 * - Not inside a condition (if/while/until/&&/||)
 * - Not in a negated pipeline
 * - Not already handling an ERR trap (prevent recursion)
 *
 * @param ctx - The interpreter context
 * @param inCondition - Whether we are in a condition context
 * @param pipelineNegated - Whether the pipeline was negated (! cmd)
 * @returns The trap execution result, or null if trap was not fired
 */
export async function executeErrTrap(
  ctx: InterpreterContext,
  inCondition: boolean,
  pipelineNegated: boolean,
): Promise<ExecResult | null> {
  // Skip if no ERR handler or conditions prevent firing
  if (!ctx.state.trapHandlers?.has("ERR")) return null;
  if (inCondition) return null;
  if (pipelineNegated) return null;

  // Prevent infinite recursion: mark that we are executing an ERR trap
  const trapState = ctx.__executingErrTrap;
  if (trapState) return null;

  ctx.__executingErrTrap = true;
  try {
    return await executeTrap(ctx, "ERR");
  } finally {
    ctx.__executingErrTrap = false;
  }
}

/**
 * Execute the EXIT trap.
 * Fires when the script finishes (normal completion, exit, or error).
 * Idempotent: only fires once per context (prevents re-entry when the trap
 * handler itself causes executeScript to complete).
 *
 * @param ctx - The interpreter context
 * @returns The trap execution result, or null if no handler registered
 */
export async function executeExitTrap(
  ctx: InterpreterContext,
): Promise<ExecResult | null> {
  if (ctx.__exitTrapFired) return null;
  ctx.__exitTrapFired = true;
  return executeTrap(ctx, "EXIT");
}

/**
 * Execute the RETURN trap.
 * Fires after a function body completes (both success and failure).
 *
 * @param ctx - The interpreter context
 * @returns The trap execution result, or null if no handler registered
 */
export async function executeReturnTrap(
  ctx: InterpreterContext,
): Promise<ExecResult | null> {
  if (ctx.__executingReturnTrap) return null;
  ctx.__executingReturnTrap = true;
  try {
    return await executeTrap(ctx, "RETURN");
  } finally {
    ctx.__executingReturnTrap = false;
  }
}

/**
 * Execute the DEBUG trap.
 * Fires before each simple command execution.
 *
 * @param ctx - The interpreter context
 * @returns The trap execution result, or null if no handler registered
 */
export async function executeDebugTrap(
  ctx: InterpreterContext,
): Promise<ExecResult | null> {
  // Prevent recursion: DEBUG trap executing commands should not re-trigger DEBUG
  const trapState = ctx.__executingDebugTrap;
  if (trapState) return null;

  ctx.__executingDebugTrap = true;
  try {
    return await executeTrap(ctx, "DEBUG");
  } finally {
    ctx.__executingDebugTrap = false;
  }
}
