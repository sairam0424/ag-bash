import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { DebuggerBridge } from "./debugger.js";

/**
 * Breakpoint / step / continue coverage for the publicly exported
 * `DebuggerBridge` (re-exported from src/index.ts).
 *
 * Relocated from a root-level `verify-intelligence.test.ts` scratch harness,
 * which was the ONLY coverage of this API anywhere in src/ and had been
 * permanently red. Two things were wrong with it:
 *
 *  - it passed `parserEngine: "legacy"` — a flat option that no longer exists.
 *    The legacy engine itself is still supported; the option moved to
 *    `parser: { engine: "legacy" }` (cf. src/observations-at-source.test.ts).
 *    The engine matters here: breakpoints key off per-statement line numbers.
 *  - it lived at the package root, so no vitest config collected it
 *    (`vitest.unit.config.ts` includes `src/**` only), and its debug
 *    `console.log` calls would have polluted the suite once it did.
 *
 * Pause state is observed through the public `isPaused()` accessor.
 */

/** Poll a predicate until true, or return false once the budget is spent. */
async function waitUntil(
  predicate: () => boolean,
  { timeoutMs = 5000, stepMs = 10 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

describe("DebuggerBridge breakpoints", () => {
  it("calls onBeforeStatement for each statement, and reports which line each carries", async () => {
    const bridge = new DebuggerBridge();
    const seen: Array<number | undefined> = [];
    const original = bridge.onBeforeStatement.bind(bridge);
    bridge.onBeforeStatement = async (node, state) => {
      seen.push(node.line);
      return original(node, state);
    };

    const bash = new Bash({
      debug: { debugger: bridge },
      parser: { engine: "legacy" },
    });
    const result = await bash.exec('echo "a"\necho "b"\necho "c"');

    expect(result.exitCode).toBe(0);
    // The hook must fire at all — this is the wiring assertion.
    expect(seen.length).toBeGreaterThan(0);
    // And it must carry usable 1-indexed line numbers, because
    // onBeforeStatement matches breakpoints via `node.line ?? 0`. If these are
    // all undefined or 0, no breakpoint can ever match — see the next test.
    expect(seen).toContain(3);
  }, 20_000);

  /**
   * REGRESSION — this was an `it.fails` documenting a real defect. Every
   * component was individually correct, which is what made it confusing:
   *
   *  - `DebuggerBridge` is public API (exported at src/index.ts:78).
   *  - The hook IS wired: Bash.ts:1040 passes `debugger: this.debugger` into
   *    the interpreter ctx, and interpreter.ts:545-547 awaits
   *    `onBeforeStatement` whenever `ctx.debugger` is set.
   *  - The hook DOES fire with correct 1-indexed lines — proven by the passing
   *    test above, which observes line 3 for a 3-statement script.
   *  - `onBeforeStatement` correctly matched `breakpoints.has(node.line ?? 0)`.
   *
   * The break was in the *pause primitive*, one frame deeper.
   * `waitForResume()` busy-waited on `while (this.paused) await new
   * Promise(r => setTimeout(r, 100))`. `executeStatement` calls the hook
   * immediately after `assertDefenseContext("statement")` — i.e. inside the
   * defense-in-depth AsyncLocalStorage context, where `globalThis.setTimeout`
   * is a proxy that throws `SecurityViolationError` (gated on
   * `sandboxActive === true`; security/blocked-globals.ts:88-94). So the first
   * breakpoint hit threw out of the hook rather than pausing, and the script
   * ran to completion in ~24ms. Fix: resolver-based resume, no timer at all.
   */
  it("pauses at a breakpoint, steps to the next statement, then runs to completion", async () => {
    const bridge = new DebuggerBridge();
    const bash = new Bash({
      // NOT a top-level `debugger:` — the constructor reads
      // `options.debug?.debugger` (Bash.ts:685). The top-level `debugger?:`
      // field belongs to ExecOptions ("specific to this call"), so passing it
      // there is silently ignored and no statement hook ever fires.
      debug: { debugger: bridge },
      // Breakpoints resolve by statement line number, which the legacy parser
      // tracks; tree-sitter is the default engine.
      parser: { engine: "legacy" },
    });

    const isPaused = () => bridge.isPaused();

    bridge.setBreakpoint(3);

    let settled = false;
    const execPromise = bash.exec(
      ['echo "Line 1"', 'echo "Line 2"', 'echo "Line 3"', 'echo "Line 4"'].join(
        "\n",
      ),
    );
    void execPromise.then(() => {
      settled = true;
    });

    // Must pause rather than run to completion.
    expect(await waitUntil(() => isPaused() || settled)).toBe(true);
    expect(settled, "execution ran past the breakpoint").toBe(false);
    expect(isPaused()).toBe(true);

    bridge.step();
    expect(await waitUntil(() => isPaused() || settled)).toBe(true);
    expect(isPaused(), "step() did not pause on the next statement").toBe(true);

    bridge.continue();
    const result = await execPromise;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Line 1");
    expect(result.stdout).toContain("Line 4");
    // Pins the root cause: pausing must not reach for a global blocked inside
    // the defense-in-depth context. If the busy-wait ever comes back, this is
    // the message that surfaces.
    expect(result.stderr).not.toContain("blocked during script execution");
  }, 20_000);

  it("runs straight through when no breakpoint is set", async () => {
    const bridge = new DebuggerBridge();
    const bash = new Bash({
      debug: { debugger: bridge },
      parser: { engine: "legacy" },
    });

    const result = await bash.exec('echo "a"\necho "b"');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("a");
    expect(result.stdout).toContain("b");
    expect(bridge.isPaused()).toBe(false);
  }, 20_000);
});
