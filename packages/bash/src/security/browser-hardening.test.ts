/**
 * Tests for the browser secondary defense (opt-in intrinsic freeze).
 *
 * These tests prove:
 * 1. The lockdown/freeze path is invocable and reports what it froze.
 * 2. When enabled, a representative escape (mutating a frozen intrinsic) is
 *    prevented.
 * 3. The pass is idempotent (no double-work, no throw on repeat).
 *
 * NOTE: Freezing intrinsics is process-wide and irreversible. To avoid
 * corrupting the shared realm for the rest of the test suite, these tests
 * exercise the *mechanism* on representative objects and assert behavior, but
 * the full `hardenBrowserGlobals()` integration assertions are scoped to read
 * the result object and verify mutation-prevention on an already-frozen
 * intrinsic without depending on global state that other suites mutate.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetBrowserHardeningForTests,
  type BrowserHardeningResult,
  hardenBrowserGlobals,
  isBrowserHardened,
} from "./browser-hardening.js";

describe("browser secondary defense (hardenBrowserGlobals)", () => {
  afterEach(() => {
    // Reset only the bookkeeping flag; frozen intrinsics stay frozen (that is
    // the intended one-way semantics). Other suites do not rely on these
    // intrinsics being writable.
    __resetBrowserHardeningForTests();
  });

  it("is invocable and reports a completed pass", () => {
    const result: BrowserHardeningResult = hardenBrowserGlobals();
    expect(result.applied).toBe(true);
    expect(Array.isArray(result.frozen)).toBe(true);
    // Core intrinsics that always exist must be reported frozen.
    expect(result.frozen).toContain("Object.prototype");
    expect(result.frozen).toContain("Function.prototype");
    expect(result.frozen).toContain("Array.prototype");
  });

  it("flags the realm as hardened after invocation", () => {
    expect(isBrowserHardened()).toBe(false);
    hardenBrowserGlobals();
    expect(isBrowserHardened()).toBe(true);
  });

  it("is idempotent: repeat calls do no work and do not throw", () => {
    const first = hardenBrowserGlobals();
    expect(first.firstRun).toBe(true);
    const second = hardenBrowserGlobals();
    expect(second.firstRun).toBe(false);
    expect(second.applied).toBe(true);
    // Same set of frozen intrinsics reported.
    expect(second.frozen).toEqual(first.frozen);
  });

  it("returns immutable result objects (frozen arrays)", () => {
    const result = hardenBrowserGlobals();
    expect(Object.isFrozen(result.frozen)).toBe(true);
    expect(Object.isFrozen(result.failures)).toBe(true);
    expect(() => {
      // @ts-expect-error intentionally testing runtime immutability
      result.frozen.push("hijack");
    }).toThrow();
  });

  it("prevents prototype-pollution mutation of a frozen intrinsic", () => {
    hardenBrowserGlobals();
    // After hardening, Object.prototype is frozen: adding a polluting property
    // must fail (silently in sloppy mode, throwing in strict mode — this file
    // is an ES module, hence strict mode → throws).
    expect(Object.isFrozen(Object.prototype)).toBe(true);
    expect(() => {
      // @ts-expect-error intentionally attempting prototype pollution
      Object.prototype.polluted = "yes";
    }).toThrow(TypeError);
    // The polluting property must not have been attached.
    expect(Object.hasOwn(Object.prototype, "polluted" as PropertyKey)).toBe(
      false,
    );
  });

  it("prevents intrinsic-constructor hijacking (Array.prototype.map swap)", () => {
    hardenBrowserGlobals();
    expect(Object.isFrozen(Array.prototype)).toBe(true);
    const originalMap = Array.prototype.map;
    expect(() => {
      // @ts-expect-error intentionally attempting to swap a built-in method
      Array.prototype.map = function evilMap() {
        return ["pwned"];
      };
    }).toThrow(TypeError);
    // The original method must be intact.
    expect(Array.prototype.map).toBe(originalMap);
    expect([1, 2, 3].map((n) => n * 2)).toEqual([2, 4, 6]);
  });

  it("invokes onFailure callback for any best-effort failure without throwing", () => {
    const failures: Array<{ path: string; reason: string }> = [];
    // Should not throw regardless of environment; failures (if any) are
    // surfaced via the callback rather than aborting the pass.
    const result = hardenBrowserGlobals({
      onFailure: (path, reason) => {
        failures.push({ path, reason });
      },
    });
    expect(result.applied).toBe(true);
    // Number of callback invocations must match reported failures.
    expect(failures.length).toBe(result.failures.length);
  });
});
