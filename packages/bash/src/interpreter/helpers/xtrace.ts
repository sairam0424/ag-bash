/**
 * xtrace (set -x) helper functions
 *
 * Handles trace output generation when xtrace option is enabled.
 * PS4 variable controls the prefix (default "+ ").
 * PS4 is expanded (variable substitution) before each trace line.
 */

import { Parser } from "../../parser/parser.js";
import { expandWord } from "../expansion.js";
import type { InterpreterContext } from "../types.js";

/**
 * Default PS4 value when not set
 */
const DEFAULT_PS4 = "+ ";

/**
 * Expand the PS4 variable and return the trace prefix.
 * PS4 is expanded with variable substitution.
 * If PS4 expansion fails, falls back to default "+ ".
 */
async function getXtracePrefix(ctx: InterpreterContext): Promise<string> {
  const ps4 = ctx.state.env.get("PS4");

  // If PS4 is not set, return default
  if (ps4 === undefined) {
    return DEFAULT_PS4;
  }

  // If PS4 is empty string (explicitly unset), bash uses no prefix
  // Actually, bash outputs nothing for trace lines when PS4 is empty
  if (ps4 === "") {
    return "";
  }

  try {
    // Parse PS4 as a word to handle variable expansion
    const parser = new Parser();
    const wordNode = parser.parseWordFromString(ps4, false, false);

    // Expand the word (handles $VAR, ${VAR}, $?, $LINENO, etc.)
    const expanded = await expandWord(ctx, wordNode);

    return expanded;
  } catch {
    // If expansion fails, print error to stderr (like bash does) and return literal PS4
    // Bash continues execution but reports the error
    ctx.state.expansionStderr = `${ctx.state.expansionStderr || ""}bash: ${ps4}: bad substitution\n`;
    return ps4 || DEFAULT_PS4;
  }
}

/**
 * Generate xtrace output for an assignment.
 * Returns the trace line to be added to stderr.
 */
export async function traceAssignment(
  ctx: InterpreterContext,
  name: string,
  value: string,
): Promise<string> {
  if (!ctx.state.options.xtrace) {
    return "";
  }

  const prefix = await getXtracePrefix(ctx);
  // Don't quote the assignment value - show raw name=value
  return `${prefix}${name}=${value}\n`;
}
