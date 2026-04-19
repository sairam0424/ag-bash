import type { InterpreterState } from "../interpreter/types.js";
import type { ExecResult } from "../types.js";

/**
 * Agentic Healer for Ag-Bash.
 * 
 * Provides automated troubleshooting and recovery suggestions for 
 * failed shell commands.
 */
export class AgenticHealer {
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
    state: InterpreterState
  ): Promise<string | null> {
    const stderr = result.stderr.toLowerCase();
    
    // 1. Missing directory/file
    if (stderr.includes("no such file or directory")) {
      return `Target in '${command}' was not found. Check if the path is correct in ${state.cwd}.`;
    }

    // 2. Permission denied
    if (stderr.includes("permission denied")) {
      return `Permission denied when executing '${command}'. Check file permissions or ownership.`;
    }

    // 3. Command not found (if reached here, built-in search failed)
    if (stderr.includes("command not found")) {
      return `The command '${command.split(' ')[0]}' is missing. Try installing it or checking your PATH.`;
    }

    // 4. Missing flags or arguments
    if (stderr.includes("missing operand") || stderr.includes("requires an argument")) {
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
    state: InterpreterState
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
`;
  }
}
