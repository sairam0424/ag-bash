/**
 * NormalizeStage - Script normalization.
 *
 * Handles:
 * - Empty script short-circuit (exit 0)
 * - Heredoc delimiter normalization
 * - Leading whitespace stripping (preserving heredoc content)
 */

import { mapToRecordWithExtras } from "../../helpers/env.js";
import type { BashExecResult } from "../../types.js";
import type { PipelineContext, PipelineStage, StageResult } from "../types.js";

/**
 * Normalize a script by stripping leading whitespace from lines,
 * while preserving whitespace inside heredoc content.
 */
function normalizeScript(script: string): string {
  const lines = script.split("\n");
  const result: string[] = [];

  // Stack of pending heredoc delimiters (for nested heredocs)
  const pendingDelimiters: { delimiter: string; stripTabs: boolean }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // If we're inside a heredoc, check if this line ends it
    if (pendingDelimiters.length > 0) {
      const current = pendingDelimiters[pendingDelimiters.length - 1];
      // For <<-, strip leading tabs when checking delimiter
      // For <<, require exact match (no leading whitespace allowed)
      const lineToCheck = current.stripTabs ? line.replace(/^\t+/, "") : line;
      if (lineToCheck === current.delimiter) {
        // End of heredoc - this line can be normalized
        result.push(line.trimStart());
        pendingDelimiters.pop();
        continue;
      }
      // Inside heredoc - preserve the line exactly as-is
      result.push(line);
      continue;
    }

    // Not inside a heredoc - normalize the line and check for heredoc starts
    const normalizedLine = line.trimStart();
    result.push(normalizedLine);

    // Check for heredoc operators in this line
    // Match: <<DELIM, <<-DELIM, << 'DELIM', <<- "DELIM", etc.
    // Multiple heredocs on one line are possible: cmd <<EOF1 <<EOF2
    const heredocPattern = /<<(-?)\s*(['"]?)([\w-]+)\2/g;
    for (const match of normalizedLine.matchAll(heredocPattern)) {
      const stripTabs = match[1] === "-";
      const delimiter = match[3];
      pendingDelimiters.push({ delimiter, stripTabs });
    }
  }

  return result.join("\n");
}

export class NormalizeStage implements PipelineStage {
  readonly name = "normalize";

  async execute(context: PipelineContext): Promise<StageResult> {
    const { rawScript, options, bash, execState } = context;

    // Empty script short-circuit
    if (!rawScript.trim()) {
      const emptyResult: BashExecResult = {
        stdout: "",
        stderr: "",
        exitCode: 0,
        env: mapToRecordWithExtras(execState.env, options?.env),
      };
      return { continue: false, result: emptyResult };
    }

    // Heredoc normalization (ensure delimiters are trimmed if not in raw mode)
    let commandLine = options?.rawScript
      ? rawScript
      : rawScript.replace(
          /<<-?\s*["']?(\w+)["']?/g,
          (_match, delimiter) => `<<${delimiter}`,
        );

    // Log command execution if logger is available
    const bashWithLogger = bash as unknown as { logger?: { info(msg: string, data?: Record<string, unknown>): void } };
    bashWithLogger.logger?.info("exec", { command: commandLine });

    // Normalize indented multi-line scripts (unless rawScript is true)
    if (!options?.rawScript) {
      commandLine = normalizeScript(commandLine);
    }

    context.normalizedScript = commandLine;
    return { continue: true, context };
  }
}
