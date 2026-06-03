import { ExecutionLimitError, NounsetError } from "../interpreter/errors.js";
import type { InterpreterContext } from "../interpreter/types.js";
import { LexerError } from "../parser/lexer.js";
import { ParseException } from "../parser/types.js";
import { SecurityViolationError } from "../security/defense-in-depth-box.js";
import type { ExecResult, Observation } from "../types.js";

/**
 * AgTrace - Agent Observability Layer
 *
 * Provides rich metadata and suggestions for command failures.
 */
export const AgTrace = {
  /**
   * Analyze a command execution failure and generate observations.
   *
   * AgTrace is the FALLBACK channel (A3): it regex-scrapes English stderr
   * for failures that the source could not emit a typed observation for
   * (e.g. WASM/external commands). Observations the SOURCE already emitted
   * are passed via `existing` so AgTrace can DEDUP/GATE and avoid producing
   * a duplicate for the same failure. Scraped observations are lower
   * confidence (0.5) than source-emitted ones (1.0).
   */
  async analyze(
    ctx: InterpreterContext,
    command: string,
    args: string[],
    result: ExecResult,
    existing: readonly Observation[] = result.observations ?? [],
  ): Promise<Observation[]> {
    const observations: Observation[] = [];
    const hasType = (type: Observation["type"]): boolean =>
      existing.some((o) => o.type === type);

    // 1. Command Not Found / Typos
    // GATE: skip if the source already emitted a typed command_not_found.
    if (
      !hasType("command_not_found") &&
      (result.exitCode === 127 || result.stderr.includes("command not found"))
    ) {
      const suggestion = AgTrace.getCommandSuggestion(ctx, command);
      observations.push({
        type: "command_not_found",
        confidence: 0.5,
        message: `Command '${command}' not found.`,
        command,
        suggestions: suggestion ? [suggestion] : [],
        context: {
          exitCode: result.exitCode,
        },
      });
    }

    // 2. File / Directory Not Found
    //
    // The SOURCE (readFiles, command resolution) emits a plain, high-confidence
    // file_not_found. AgTrace still runs its richer path analysis to ENRICH —
    // it can detect a missing PARENT directory (directory_not_found) or a
    // case-insensitive match (a "Correct the casing" suggestion) that the
    // source cannot. Dedup is handled downstream by
    // {@link AgTrace.combineObservations}: a fresh observation that matches an
    // existing one by type+path is MERGED (suggestions folded in) rather than
    // double-emitted; anything genuinely new is appended.
    if (
      result.stderr.toLowerCase().includes("no such file or directory") ||
      result.stderr.toLowerCase().includes("does not exist")
    ) {
      const pathArg = args.find(
        (arg) => arg.startsWith("/") || arg.includes("."),
      );
      if (pathArg) {
        const obs = await AgTrace.analyzePathFailure(ctx, pathArg);
        if (obs) observations.push({ confidence: 0.5, ...obs });
      }
    }

    // 3. Permission Denied
    // GATE: skip if the source already emitted permission_denied.
    if (
      !hasType("permission_denied") &&
      result.stderr.includes("Permission denied")
    ) {
      observations.push({
        type: "permission_denied",
        confidence: 0.5,
        message:
          "Operation permitted by security policy or filesystem constraints.",
        command,
        context: {
          uid: ctx.state.virtualUid,
          gid: ctx.state.virtualGid,
        },
      });
    }

    // 4. Missing Dependencies (Optional Packages)
    if (
      result.stderr.toLowerCase().includes("not installed") ||
      result.stderr.toLowerCase().includes("module not found")
    ) {
      const pkg = result.stderr.match(
        /'([^']+)' not installed|module '([^']+)'/i,
      );
      const pkgName = pkg ? pkg[1] || pkg[2] : null;

      if (pkgName) {
        observations.push({
          type: "suggestion",
          message: `The command requires the optional package '${pkgName}'.`,
          suggestions: [
            `Run 'pnpm add ${pkgName}' in the host environment to enable this feature.`,
          ],
          context: { pkgName },
        });
      }
    }

    // 5. MCP Tool Call Failures
    if (
      result.stderr.includes("MCP error") ||
      (result.stderr.includes("Connection") &&
        result.stderr.includes("not found"))
    ) {
      observations.push({
        type: "suggestion",
        message:
          "An MCP tool call failed. This might be due to a disconnected server or missing tool.",
        suggestions: [
          "Run 'ag-mcp list' to check active connections.",
          "Run 'ag-mcp connect' to reconnect to the server.",
        ],
      });
    }

    // 6. Notebook Errors
    if (
      result.stderr.toLowerCase().includes("notebook") &&
      result.stderr.toLowerCase().includes("invalid")
    ) {
      observations.push({
        type: "suggestion",
        message:
          "The notebook file might be malformed or the cell index is out of bounds.",
        suggestions: [
          "Run 'ag-notebook read <path>' to check the cell structure.",
        ],
      });
    }

    return observations;
  },

  /**
   * Combine source-emitted observations with AgTrace's fresh (fallback)
   * observations into a single deduplicated list (A3).
   *
   * Dedup/merge rules, applied immutably (always new objects/arrays):
   *  - A fresh observation that ENRICHES an existing one (same `type` AND same
   *    `path`) is MERGED into it: the existing observation gains the fresh
   *    `suggestions` (unioned) and keeps its higher source `confidence`. This
   *    keeps exactly one observation per failure while preserving the
   *    actionable fix (e.g. a case-insensitive "Correct the casing" hint).
   *  - A fresh observation with no matching existing one is appended.
   *
   * @param existing - Source-emitted (high-confidence) observations.
   * @param fresh - AgTrace fallback observations from {@link AgTrace.analyze}.
   */
  combineObservations(
    existing: readonly Observation[],
    fresh: readonly Observation[],
  ): Observation[] {
    // Start from immutable copies of the existing source observations.
    let merged: Observation[] = existing.map((o) => ({ ...o }));
    const toAppend: Observation[] = [];

    for (const f of fresh) {
      const idx = merged.findIndex(
        (e) => e.type === f.type && e.path === f.path,
      );
      if (idx === -1) {
        toAppend.push(f);
        continue;
      }
      // Enrich the matching existing observation with the fresh suggestions.
      const target = merged[idx];
      const suggestions = Array.from(
        new Set([...(target.suggestions ?? []), ...(f.suggestions ?? [])]),
      );
      const enriched: Observation = {
        ...target,
        ...(suggestions.length > 0 ? { suggestions } : null),
      };
      merged = merged.map((o, i) => (i === idx ? enriched : o));
    }

    return [...merged, ...toAppend];
  },

  /**
   * Analyze a caught error during execution.
   */
  analyzeError(error: Error): Observation {
    const errorName =
      error.name || (error.constructor ? error.constructor.name : "");

    if (
      error instanceof SecurityViolationError ||
      errorName === "SecurityViolationError"
    ) {
      const violation = (error as any).violation;
      return {
        type: "security_violation",
        message: "A security violation was blocked by defense-in-depth.",
        context: {
          violation,
        },
      };
    }

    if (
      error instanceof ExecutionLimitError ||
      errorName === "ExecutionLimitError"
    ) {
      const limitType = (error as any).limitType;
      return {
        type: "limit_exceeded",
        message: "An execution limit was exceeded.",
        context: {
          limitType,
        },
        suggestions: [
          `Increase executionLimits.${limitType} in Bash options if this is intentional.`,
        ],
      };
    }

    if (error instanceof ParseException || error instanceof LexerError) {
      return {
        type: "syntax_error",
        message: error.message,
        context: {
          line: (error as any).line,
          column: (error as any).column,
        },
      };
    }

    if (error instanceof NounsetError) {
      return {
        type: "syntax_error",
        message: `Unbound variable: ${error.varName}`,
        suggestions: [
          `Check if ${error.varName} is defined or use default value syntax: \${${error.varName}:-default}`,
        ],
      };
    }

    return {
      type: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  },

  /**
   * Get a command typo suggestion using Levenshtein distance.
   *
   * Public so source emitters (e.g. command-not-found in builtin-dispatch)
   * can attach the same "did you mean" candidate to a typed Observation at
   * the source, instead of relying on AgTrace's stderr regex pass.
   *
   * @param command - The unresolved command name.
   * @param candidates - Candidate command names to match against.
   * @returns The closest match within the typo threshold, or null.
   */
  suggestCommand(
    command: string,
    candidates: readonly string[],
  ): string | null {
    // Built-in keywords that might not be in registered commands
    const builtins = [
      "cd",
      "exit",
      "export",
      "unset",
      "alias",
      "unalias",
      "source",
      "eval",
      "read",
    ];
    const all = Array.from(new Set([...candidates, ...builtins]));

    let bestMatch: string | null = null;
    let minDistance = Infinity;

    for (const cmd of all) {
      const dist = AgTrace.levenshtein(command, cmd);
      if (dist < minDistance) {
        minDistance = dist;
        bestMatch = cmd;
      }
    }

    // Heuristic: threshold depends on length
    const threshold = command.length <= 4 ? 1 : 2;
    return minDistance <= threshold ? bestMatch : null;
  },

  /**
   * Get a command typo suggestion from the interpreter's registered commands.
   */
  getCommandSuggestion(
    ctx: InterpreterContext,
    command: string,
  ): string | null {
    const commands = ctx.getRegisteredCommands
      ? ctx.getRegisteredCommands()
      : [];
    return AgTrace.suggestCommand(command, commands);
  },

  /**
   * Investigates why a path failed (e.g. parent doesn't exist).
   */
  async analyzePathFailure(
    ctx: InterpreterContext,
    path: string,
  ): Promise<Observation | null> {
    const exists = await ctx.fs.exists(path);
    if (!exists) {
      // Look for case-insensitive matches in the same directory
      const parts = path.split("/");
      const fileName = parts.pop() || "";
      const dirPath = parts.join("/") || ".";

      try {
        const dirEntries = await ctx.fs.readdir(dirPath);
        const match = dirEntries.find(
          (e) => e.toLowerCase() === fileName.toLowerCase(),
        );
        if (match) {
          return {
            type: "file_not_found",
            message: `Path '${path}' not found, but a case-insensitive match '${dirPath === "." ? "" : `${dirPath}/`}${match}' exists.`,
            path: path,
            suggestions: [`Correct the casing to '${match}'`],
          };
        }
      } catch {
        // Parent directory might not exist either
      }

      const resolved = ctx.fs.resolvePath(ctx.state.cwd, path);
      const resolvedParts = resolved.split("/").filter((p) => p !== "");

      // Check parent directories
      let current = resolved.startsWith("/") ? "" : "";
      for (let i = 0; i < resolvedParts.length - 1; i++) {
        current += `/${resolvedParts[i]}`;
        try {
          await ctx.fs.stat(current);
        } catch {
          return {
            type: "directory_not_found",
            message: `Parent directory '${current}' does not exist.`,
            path: current,
            suggestions: [`mkdir -p ${current}`],
          };
        }
      }

      return {
        type: "file_not_found",
        message: `File '${path}' not found in '${ctx.state.cwd}'.`,
        path: resolved,
      };
    }

    // Path exists, check if it's the wrong type
    try {
      const stats = await ctx.fs.stat(path);
      // If code got here, the caller already reported an error, so we find why.
      // Usually "is a directory" or "not a directory"
      return {
        type: "unknown",
        message: `'${path}' exists but caused an error.`,
        path,
        context: {
          isDirectory: stats.isDirectory,
          isFile: stats.isFile,
          mode: stats.mode,
        },
      };
    } catch {
      return null;
    }
  },

  /**
   * Damerau-Levenshtein distance (simple version)
   */
  levenshtein(s1: string, s2: string): number {
    const len1 = s1.length;
    const len2 = s2.length;
    const matrix: number[][] = [];

    for (let i = 0; i <= len1; i++) matrix[i] = [i];
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;

    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost,
        );
      }
    }
    return matrix[len1][len2];
  },
};
