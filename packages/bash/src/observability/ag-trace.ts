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
export class AgTrace {
  /**
   * Analyze a command execution failure and generate observations.
   */
  static async analyze(
    ctx: InterpreterContext,
    command: string,
    args: string[],
    result: ExecResult,
  ): Promise<Observation[]> {
    const observations: Observation[] = [];

    // 1. Command Not Found / Typos
    if (
      result.exitCode === 127 ||
      result.stderr.includes("command not found")
    ) {
      const suggestion = AgTrace.getCommandSuggestion(ctx, command);
      observations.push({
        type: "command_not_found",
        message: `Command '${command}' not found.`,
        command,
        suggestions: suggestion ? [suggestion] : [],
        context: {
          exitCode: result.exitCode,
        },
      });
    }

    // 2. File / Directory Not Found
    if (
      result.stderr.toLowerCase().includes("no such file or directory") ||
      result.stderr.toLowerCase().includes("does not exist")
    ) {
      const pathArg = args.find(
        (arg) => arg.startsWith("/") || arg.includes("."),
      );
      if (pathArg) {
        const obs = await AgTrace.analyzePathFailure(ctx, pathArg);
        if (obs) observations.push(obs);
      }
    }

    // 3. Permission Denied
    if (result.stderr.includes("Permission denied")) {
      observations.push({
        type: "permission_denied",
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
  }

  /**
   * Analyze a caught error during execution.
   */
  static analyzeError(error: Error): Observation {
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
  }

  /**
   * Get a command typo suggestion using Levenshtein distance.
   */
  private static getCommandSuggestion(
    ctx: InterpreterContext,
    command: string,
  ): string | null {
    const commands = ctx.getRegisteredCommands
      ? ctx.getRegisteredCommands()
      : [];
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
    const all = Array.from(new Set([...commands, ...builtins]));

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
  }

  /**
   * Investigates why a path failed (e.g. parent doesn't exist).
   */
  private static async analyzePathFailure(
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
  }

  /**
   * Damerau-Levenshtein distance (simple version)
   */
  private static levenshtein(s1: string, s2: string): number {
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
  }
}
