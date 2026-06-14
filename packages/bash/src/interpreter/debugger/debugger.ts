import type { StatementNode } from "../../ast/types.js";
import type { InterpreterState } from "../types.js";

/**
 * Debugger Bridge for Ag-Bash.
 *
 * Provides interactive execution control for shell scripts.
 */
export class DebuggerBridge {
  private breakpoints: Set<number> = new Set();
  private paused: boolean = false;
  private stepRequested: boolean = false;

  /**
   * Registers a breakpoint at a specific line.
   */
  public setBreakpoint(line: number): void {
    this.breakpoints.add(line);
  }

  /**
   * Removes a breakpoint.
   */
  public clearBreakpoint(line: number): void {
    this.breakpoints.delete(line);
  }

  /**
   * Called by the interpreter at each statement boundary.
   * If a breakpoint is hit or a step is active, pauses execution.
   */
  public async onBeforeStatement(
    node: StatementNode,
    _state: InterpreterState,
  ): Promise<void> {
    const currentLine = node.line ?? 0;

    if (this.breakpoints.has(currentLine) || this.stepRequested) {
      this.paused = true;
      this.stepRequested = false;
      await this.waitForResume();
    }
  }

  /**
   * Resumes execution until the next breakpoint.
   */
  public continue(): void {
    this.paused = false;
  }

  /**
   * Executes only the next statement.
   */
  public step(): void {
    this.stepRequested = true;
    this.paused = false;
  }

  /**
   * Internal loop to block execution while paused.
   */
  private async waitForResume(): Promise<void> {
    while (this.paused) {
      // In a real implementation, this would yield to an event loop
      // or wait for a specific signal/promise resolve.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Returns current execution context for inspection.
   */
  public getInspectState(state: InterpreterState): any {
    return {
      cwd: state.cwd,
      env: Object.assign(Object.create(null), Object.fromEntries(state.env)),
      localScopes: state.localScopes.map((s) =>
        Object.assign(Object.create(null), Object.fromEntries(s)),
      ),
      lastExitCode: state.lastExitCode,
    };
  }
}
