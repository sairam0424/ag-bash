import {
  getCommandNames,
  getJavaScriptCommandNames,
  getNetworkCommandNames,
  getPythonCommandNames,
} from "../commands/registry.js";
import { NounsetError } from "../interpreter/errors.js";
import { SHELL_BUILTINS } from "../interpreter/helpers/shell-constants.js";
import type {
  InterpreterContext,
  InterpreterState,
} from "../interpreter/types.js";
import { levenshtein, SymbolType } from "../lsp/semantic-engine.js";
import type { ExecResult } from "../types.js";
import type { BashToolbox } from "./BashToolbox.js";
import type { AgenticHealerConfig, RetryableFailureType } from "./types.js";

/**
 * stderr fragments that name a missing PATH rather than a missing COMMAND.
 * A missing file and a missing command are different failures with different
 * remedies, so they must never collapse into one classification: renaming the
 * command cannot fix a bad path, and normalizing a path cannot fix a typo'd
 * command name.
 */
const PATH_FAILURE_SIGNALS: readonly string[] = Object.freeze([
  "no such file",
  "no such directory",
  "cannot open",
  "cannot access",
  "cannot stat",
]);

/**
 * Words that disambiguate a BARE "not found" (no "command" in the message).
 * `sh: 1: gerp: not found` is a missing command. Every word here is one this
 * engine actually emits next to "not found": `File '/x' not found.` and
 * `Directory '/x' not found.` (interpreter/helpers/result.ts), `Error: File not
 * found: /x` (commands/ag-convert, commands/ag-notebook), and `Path '/x' not
 * found, but a case-insensitive match ... exists.` (observability/ag-trace).
 */
const PATH_SUBJECT_WORDS: readonly string[] = Object.freeze([
  "file",
  "directory",
  "path",
]);

/** Correction targets must look like an invocable command name. */
const COMMAND_NAME_SHAPE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Typo-correction dictionary, DERIVED from the real command registry plus the
 * shell builtin table.
 *
 * WHY DERIVED. This was a hand-written 43-name literal, which was wrong in both
 * directions against a registry of ~117 commands: it OMITTED most of them
 * (`git`, `jq`, `python3`, `sqlite3`, every `ag-*` tool), and since `heal()`
 * gives up when no correction is produced, everything it omitted silently got
 * no healing at all — while `gti status` matched the literal's `tr` and was
 * "corrected" to `tr status`. It also INCLUDED four commands this engine does
 * not implement (`chown`, `wget`, `unzip`, `patch`), so those corrections were
 * guaranteed to fail again. Deriving from `getCommandNames()` and friends keeps
 * the dictionary in step with the registry by construction; the two-character
 * operators (`:`, `.`, `[`) are excluded because they are within one edit of
 * almost any short token.
 */
const TYPO_CORRECTION_CANDIDATES: readonly string[] = Object.freeze(
  Array.from(
    new Set<string>([
      ...getCommandNames(),
      ...getNetworkCommandNames(),
      ...getPythonCommandNames(),
      ...getJavaScriptCommandNames(),
      ...SHELL_BUILTINS,
    ]),
  ).filter((name) => name.length >= 2 && COMMAND_NAME_SHAPE.test(name)),
);

/**
 * Finds the registered command closest to `cmdName`, or null when there is no
 * confident match.
 *
 * Returns null when `cmdName` IS a known command (distance 0): the name is then
 * demonstrably not the problem, and suggesting the next-nearest neighbour would
 * rewrite a perfectly good command. The edit budget is capped at
 * `min(2, length - 1)` so a correction can never rewrite the whole token —
 * without that, a one-character command matches `ls`/`rm`/`cp` at distance 2.
 */
function findClosestCommand(cmdName: string): string | null {
  const maxDistance = Math.min(2, cmdName.length - 1);
  if (maxDistance < 1) return null;

  let bestMatch: string | null = null;
  let bestDistance = Infinity;
  for (const known of TYPO_CORRECTION_CANDIDATES) {
    const distance = levenshtein(cmdName, known);
    if (distance === 0) return null;
    if (distance <= maxDistance && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = known;
    }
  }
  return bestMatch;
}

/**
 * Agentic Healer for Ag-Bash.
 *
 * Provides automated troubleshooting and recovery suggestions for
 * failed shell commands.
 */
export class AgenticHealer {
  constructor(
    private toolbox: BashToolbox | undefined = undefined,
    private config: AgenticHealerConfig = { enableHeuristics: true },
  ) {}

  /**
   * Analyzes a failed command execution and generates a recovery suggestion.
   *
   * @param command The command string that failed
   * @param result The execution result (containing stderr and exit code)
   * @param state The current interpreter state
   * @returns A string suggestion or null if no obvious fix is found
   */
  public async diagnose(
    command: string,
    result: ExecResult,
    ctx: InterpreterContext,
    error?: Error,
  ): Promise<string | null> {
    const state = ctx.state;

    // 1. Tool-based recovery (Healer 2.0)
    const toolResult = await this.diagnoseWithTools(command, result, ctx);
    if (toolResult) return toolResult;

    // 2. Heuristic check
    if (this.config.enableHeuristics !== false) {
      const heuristicResult = await this.diagnoseHeuristically(
        command,
        result,
        ctx,
        error,
      );
      if (heuristicResult) return heuristicResult;
    }

    // 3. LLM check (if configured)
    if (this.config.llm) {
      const context = this.getTroubleshootingContext(command, result, state);
      return await this.config.llm.generateSuggestion(context);
    }

    return null;
  }

  private async diagnoseHeuristically(
    command: string,
    result: ExecResult,
    ctx: InterpreterContext,
    error?: Error,
  ): Promise<string | null> {
    const state = ctx.state;
    const stderr = (result.stderr || "").toLowerCase();

    // 1. Missing directory/file
    if (stderr.includes("no such file or directory")) {
      const parts = command.split(/\s+/);
      const possiblePath = parts.find(
        (p) => p.includes("/") || p.includes("."),
      );

      if (possiblePath) {
        // Attempt fuzzy match for similar files in the same directory
        try {
          const dir = possiblePath.includes("/")
            ? possiblePath.substring(0, possiblePath.lastIndexOf("/"))
            : ".";
          const basename = possiblePath.includes("/")
            ? possiblePath.substring(possiblePath.lastIndexOf("/") + 1)
            : possiblePath;

          if (dir === "." || (await ctx.fs.stat(dir)).isDirectory) {
            const files = await ctx.fs.readdir(dir);
            const { levenshtein } = await import("../lsp/semantic-engine.js");
            const closest = files
              .map((f: string) => ({ name: f, dist: levenshtein(basename, f) }))
              .filter(
                (res: { name: string; dist: number }) =>
                  res.dist <= 2 && res.name !== basename,
              )
              .sort(
                (a: { dist: number }, b: { dist: number }) => a.dist - b.dist,
              )[0];

            if (closest) {
              const suggestedPath =
                dir === "." ? closest.name : `${dir}/${closest.name}`;
              return `Target '${possiblePath}' not found. Did you mean '${suggestedPath}'?`;
            }
          }
        } catch (_e) {
          // Ignore FS errors during healing
        }

        return `Target '${possiblePath}' in '${command}' was not found. Check if the path is correct in ${state.cwd}.`;
      }
      return `Target in '${command}' was not found. Check if the path is correct in ${state.cwd}.`;
    }

    // 2. Permission denied
    if (stderr.includes("permission denied")) {
      return `Permission denied when executing '${command}'. Check file permissions or ownership.`;
    }

    // 3. Command not found
    if (
      stderr.includes("command not found") ||
      stderr.includes("not yet implemented")
    ) {
      let cmdName = "";
      if (command.trim()) {
        const parts = command.trim().split(/\s+/);
        cmdName = parts[0];
      } else {
        // Extract command name from stderr (e.g. "bash: foo: command not found")
        const match = result.stderr.match(/bash: (.*): command not found/);
        if (match) {
          cmdName = match[1];
        }
      }

      if (!cmdName) return null;

      // Use SemanticEngine for fuzzy matching if available
      if (ctx.semanticEngine) {
        const suggestions = ctx.semanticEngine.fuzzySearchSymbols(
          cmdName,
          SymbolType.Function,
        );
        if (suggestions.length > 0) {
          return `Command '${cmdName}' not found. Did you mean function '${suggestions[0].name}'?`;
        }
      }

      // Check registered commands (builtins)
      if (ctx.getRegisteredCommands) {
        const registered = ctx.getRegisteredCommands();
        const { levenshtein } = await import("../lsp/semantic-engine.js");

        // Find closest among registered commands
        const closestRegistered = registered
          .map((c) => ({ name: c, dist: levenshtein(cmdName, c) }))
          .filter((res) => res.dist <= 2)
          .sort((a, b) => a.dist - b.dist)[0];

        if (closestRegistered) {
          return `Command '${cmdName}' not found. Did you mean builtin '${closestRegistered.name}'?`;
        }

        // Fallback: check SHELL_BUILTINS list as well (some might not be registered but are known)
        const closestBuiltin = Array.from(SHELL_BUILTINS)
          .map((c) => ({ name: c, dist: levenshtein(cmdName, c) }))
          .filter((res) => res.dist <= 2)
          .sort((a, b) => a.dist - b.dist)[0];

        if (closestBuiltin) {
          return `Command '${cmdName}' not found. Did you mean builtin '${closestBuiltin.name}'?`;
        }
      }

      if (stderr.includes("not yet implemented")) {
        return `The command '${command}' uses a feature not yet implemented in Ag-Bash.`;
      }

      return `The command '${cmdName}' is missing. Try installing it or checking your PATH.`;
    }

    // 4. Nounset (Unset variable)
    if (error instanceof NounsetError || stderr.includes("unbound variable")) {
      const varName =
        error instanceof NounsetError
          ? error.varName
          : stderr.match(/bash: (.*): unbound variable/)?.[1] || "";

      if (varName && ctx.semanticEngine) {
        const suggestions = ctx.semanticEngine.fuzzySearchSymbols(
          varName,
          SymbolType.Variable,
        );
        if (suggestions.length > 0) {
          return `Variable '${varName}' is unbound. Did you mean '${suggestions[0].name}'?`;
        }
      }
    }

    // 5. Missing flags or arguments
    if (
      stderr.includes("missing operand") ||
      stderr.includes("requires an argument")
    ) {
      return `'${command}' is missing required arguments. Consult the man page for usage.`;
    }

    return null;
  }

  /**
   * Bundles execution context for external LLM-based troubleshooting.
   */
  public getTroubleshootingContext(
    command: string,
    result: ExecResult,
    state: InterpreterState,
  ): string {
    return `
COMMAND FAILED:
Command: ${command}
Exit Code: ${result.exitCode}
Stderr: ${result.stderr}
Stdout: ${result.stdout}

ENVIRONMENT:
CWD: ${state.cwd}
PATH: ${state.env.get("PATH")}
HOME: ${state.env.get("HOME")}
SHELL_STABLE: ${state.options.posix ? "POSIX" : "BASH"}
`;
  }

  /**
   * Healer 2.0: Suggests Agentic Tools based on failure context.
   */
  private async diagnoseWithTools(
    command: string,
    result: ExecResult,
    _ctx: InterpreterContext,
  ): Promise<string | null> {
    if (!this.toolbox) return null;

    // Semantic search for tools that might help with this specific error
    const query = `${command} failed with: ${result.stderr || "unknown error"}`;
    const tools = await this.toolbox.searchTools(query);

    if (tools.length > 0) {
      const bestTool = tools[0];
      return `Command failed. Based on the context, you might want to use the agentic tool '${bestTool.name}': ${bestTool.description}`;
    }

    return null;
  }

  // ─── Active Self-Healing ───────────────────────────────────────────────────

  /**
   * Attempt active healing: diagnose, correct, and re-execute the command.
   * Uses exponential backoff between retries and respects configured limits.
   *
   * @param command The original command that failed
   * @param result The failed execution result
   * @param execFn A function to re-execute a corrected command
   * @param attempt Current retry attempt (0-indexed)
   * @returns The healed result on success, or null if healing is not possible
   */
  public async heal(
    command: string,
    result: ExecResult,
    execFn: (cmd: string) => Promise<ExecResult>,
    attempt: number = 0,
  ): Promise<ExecResult | null> {
    // The original command is seeded as already-attempted so no chain of
    // corrections can loop back and re-run the caller's own command.
    return this.healAttempt(
      command,
      result,
      execFn,
      attempt,
      new Set([command]),
    );
  }

  /**
   * Recursive body of {@link heal}.
   *
   * `attempted` carries every command string this heal chain has already run.
   * Without it the recursion re-derives the SAME correction from the corrected
   * command (a known command is its own nearest neighbour) and re-executes the
   * identical command once per remaining retry — so a wrong correction was
   * applied `maxRetries` times instead of once, side effects included. It is
   * threaded as a new Set per level rather than mutated, and is per-call rather
   * than per-instance so a healer shared across commands never refuses a
   * legitimate later retry of the same command.
   */
  private async healAttempt(
    command: string,
    result: ExecResult,
    execFn: (cmd: string) => Promise<ExecResult>,
    attempt: number,
    attempted: ReadonlySet<string>,
  ): Promise<ExecResult | null> {
    const config = this.config?.autoRetry;
    if (!config?.enabled) return null;

    const maxRetries = config.maxRetries ?? 3;
    if (attempt >= maxRetries) return null;

    // If we cannot classify the failure at all, skip healing
    const failureType = this.classifyFailure(result);
    if (!failureType) return null;

    // Determine if this failure type is retryable
    const retryable: RetryableFailureType[] = config.retryable ?? [
      "command_not_found",
      "file_not_found",
    ];
    if (!retryable.includes(failureType)) return null;

    // Try to determine a corrected command
    const correction = this.suggestCorrection(command, result);
    if (!correction) return null;

    // Re-running a command this chain already ran is not progress: it would
    // reproduce the same failure and re-apply the same side effects.
    if (attempted.has(correction)) return null;

    // Exponential backoff
    const delay = (config.baseDelayMs ?? 100) * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delay));

    // Execute the corrected command
    const retryResult = await execFn(correction);
    if (retryResult.exitCode === 0) {
      return retryResult;
    }

    // Recursive retry with incremented attempt
    return this.healAttempt(
      correction,
      retryResult,
      execFn,
      attempt + 1,
      new Set([...attempted, correction]),
    );
  }

  /**
   * Classify a failure result into a known category.
   * Returns null if the failure does not match any recognized pattern.
   *
   * A bare "not found" is deliberately checked LAST of the not-found forms: it
   * used to be tested first, which read every "File not found: /x" and
   * "Directory '/x' not found." this engine emits as a missing COMMAND, so a
   * path failure was offered the command-name remedy (and was filtered by the
   * wrong entry of `autoRetry.retryable`).
   */
  public classifyFailure(result: ExecResult): RetryableFailureType | null {
    const stderr = result.stderr.toLowerCase();

    // Unambiguous: the message says the command itself was not found.
    if (stderr.includes("command not found")) {
      return "command_not_found";
    }
    if (PATH_FAILURE_SIGNALS.some((signal) => stderr.includes(signal))) {
      return "file_not_found";
    }
    if (stderr.includes("not found")) {
      // Ambiguous wording: a path noun in the message means a path was missing.
      return PATH_SUBJECT_WORDS.some((word) => stderr.includes(word))
        ? "file_not_found"
        : "command_not_found";
    }
    if (stderr.includes("permission denied")) {
      return "permission_denied";
    }
    if (stderr.includes("timed out") || stderr.includes("timeout")) {
      return "timeout";
    }
    return null;
  }

  /**
   * Attempt to produce a corrected command string based on error analysis.
   * Uses Levenshtein distance to find close matches for typo'd commands.
   *
   * The remedy is selected by {@link classifyFailure} so the diagnosis and the
   * mutation cannot disagree: a missing command gets a name correction, a
   * missing path gets path normalization, and anything else gets nothing.
   * A "correction" identical to the input is reported as no correction, since
   * re-running the same string is not a fix.
   */
  public suggestCorrection(command: string, result: ExecResult): string | null {
    const failureType = this.classifyFailure(result);
    let corrected: string | null = null;

    if (failureType === "command_not_found") {
      const parts = command.trim().split(/\s+/);
      const replacement = findClosestCommand(parts[0]);
      if (replacement) {
        const correctedParts = [...parts];
        correctedParts[0] = replacement;
        corrected = correctedParts.join(" ");
      }
    } else if (failureType === "file_not_found") {
      // Attempt to fix double slashes or trailing issues
      corrected = command.replace(/\/\//g, "/");
    }

    if (!corrected || corrected === command) return null;
    return corrected;
  }
}
