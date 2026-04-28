import { NounsetError } from "../interpreter/errors.js";
import type {
  InterpreterContext,
  InterpreterState,
} from "../interpreter/types.js";
import { SymbolType } from "../lsp/semantic-engine.js";
import type { ExecResult } from "../types.js";
import type { BashToolbox } from "./BashToolbox.js";
import type { AgenticHealerConfig } from "./types.js";

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
        const { SHELL_BUILTINS } = await import(
          "../interpreter/helpers/shell-constants.js"
        );
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
}
