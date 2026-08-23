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
   * Resolvers for every hook currently suspended at a breakpoint.
   *
   * Held as a list, not a single resolver, so that a bridge shared across
   * `bash.fork()` / `bash.speculate()` branches cannot orphan a waiter: one
   * `continue()` releases all of them, matching the semantics of the boolean
   * this replaced.
   */
  private resumeWaiters: ReadonlyArray<() => void> = [];

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
      this.stepRequested = false;
      await this.waitForResume();
    }
  }

  /**
   * Whether execution is currently suspended at a breakpoint or step.
   *
   * A debug front-end needs this to know when it may inspect state and when
   * `continue()` / `step()` are meaningful; without it the only way to observe
   * the paused flag is to reach through the class with a cast.
   */
  public isPaused(): boolean {
    return this.paused;
  }

  /**
   * Resumes execution until the next breakpoint.
   */
  public continue(): void {
    this.releaseWaiters();
  }

  /**
   * Executes only the next statement.
   */
  public step(): void {
    this.stepRequested = true;
    this.releaseWaiters();
  }

  /**
   * Suspends the calling hook until `continue()` or `step()` is invoked.
   *
   * SECURITY/CORRECTNESS: this must NOT poll on a timer. `onBeforeStatement`
   * is awaited from `Interpreter.executeStatement`, which runs inside the
   * defense-in-depth AsyncLocalStorage context (`sandboxActive: true`). In that
   * context `globalThis.setTimeout` is replaced by a proxy that throws
   * `SecurityViolationError` (see security/blocked-globals.ts), so the previous
   * `while (paused) await new Promise(r => setTimeout(r, 100))` busy-wait threw
   * on the very first breakpoint hit instead of pausing. A resolver captured
   * here needs no timer at all, so it is both correct under defense-in-depth
   * and free of the 100ms polling latency.
   */
  private waitForResume(): Promise<void> {
    this.paused = true;
    return new Promise<void>((resolve) => {
      this.resumeWaiters = [...this.resumeWaiters, resolve];
    });
  }

  /**
   * Clears the paused flag and wakes every suspended hook.
   */
  private releaseWaiters(): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    this.paused = false;
    for (const resolve of waiters) resolve();
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
