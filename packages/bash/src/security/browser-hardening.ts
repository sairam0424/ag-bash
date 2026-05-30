/**
 * Browser Secondary Defense (opt-in lockdown)
 *
 * Background
 * ----------
 * The Node.js secondary defense layer (DefenseInDepthBox) relies on
 * `node:async_hooks` AsyncLocalStorage to scope global monkey-patches to the
 * async context of a single `bash.exec()` call. AsyncLocalStorage does not
 * exist in browsers, so in browser builds the entire DefenseInDepthBox is a
 * no-op (its `IS_BROWSER` guard early-returns everywhere). That means the
 * browser bundle ships `Function`, `eval`, and `Proxy` fully live.
 *
 * IMPORTANT context on the actual risk:
 * - The PRIMARY architectural defense still holds in the browser: ag-bash has
 *   no bash -> JavaScript escape hatch. Bash scripts are lexed, parsed, and
 *   interpreted; there is no path from a bash command to `eval`/`Function`.
 * - This module provides the missing SECONDARY depth layer for the browser: a
 *   process-wide, opt-in hardening pass that freezes JavaScript intrinsics so
 *   that even if a future bug or a malicious host-supplied custom command tried
 *   to reach a dynamic-code primitive, the surrounding environment cannot be
 *   mutated to mount a prototype-pollution or intrinsic-hijacking escape.
 *
 * Why a lighter freeze instead of SES `lockdown()`?
 * - SES (`ses` package) is the gold-standard approach (full Compartment model
 *   + frozen realm). However it adds a runtime dependency and meaningfully
 *   changes global semantics (it freezes `Date`, `Math.random` determinism
 *   shims, taming of `Error`, etc.) which can break legitimate host code that
 *   shares the realm with ag-bash. Per the v6.0.0 risk posture we ship the
 *   lighter intrinsic-freeze here and flag SES as a documented follow-up
 *   (see SECURITY.md). The freeze approach is fully reversible-free (we never
 *   mutate values, only flip writability/extensibility) and is gated so it does
 *   not run unless the host explicitly opts in.
 *
 * This file lives under `src/security/` which is exempt from the
 * banned-pattern scanner. It deliberately references `Function`, `eval`, and
 * `Proxy` for detection/freezing purposes only — it never *invokes* them.
 */

/**
 * Whether we're running in a browser environment.
 * Defined by the bundler via --define:__BROWSER__=true. In Node.js builds this
 * is falsy. We do NOT gate hardening on this flag — `hardenBrowserGlobals()` is
 * intentionally callable in Node.js too (it is a no-op-safe superset of the
 * AsyncLocalStorage layer) — but we expose it so callers can detect the bundle.
 */
declare const __BROWSER__: boolean | undefined;

/**
 * Result of a hardening pass. Immutable snapshot describing what was frozen and
 * what (if anything) could not be frozen.
 */
export interface BrowserHardeningResult {
  /** True if hardening ran to completion (even if some best-effort freezes failed). */
  readonly applied: boolean;
  /** True if this call actually performed work; false if hardening was already applied. */
  readonly firstRun: boolean;
  /** Human-readable list of intrinsic paths that were frozen. */
  readonly frozen: readonly string[];
  /** Human-readable list of intrinsic paths that could not be frozen (best-effort). */
  readonly failures: readonly string[];
}

/**
 * Options for {@link hardenBrowserGlobals}.
 */
export interface BrowserHardeningOptions {
  /**
   * When true, also freeze `globalThis` itself (no new globals can be added).
   * This is the strictest setting and can break code that lazily attaches
   * globals (some polyfills do this). Default: false.
   */
  readonly freezeGlobalThis?: boolean;
  /**
   * Callback invoked once per intrinsic that could not be frozen. Useful for
   * surfacing environment-specific limitations without throwing.
   */
  readonly onFailure?: (path: string, reason: string) => void;
}

/**
 * Module-level guard so repeated calls are cheap and idempotent. Freezing is a
 * one-way operation, so we never need to "unharden".
 */
let hardeningApplied = false;
let lastResult: BrowserHardeningResult | null = null;

/**
 * Intrinsics whose prototypes and constructors we freeze. These are the objects
 * a prototype-pollution / intrinsic-hijack escape would target. We freeze the
 * constructor object, its `.prototype`, and the prototype's own props.
 *
 * We intentionally avoid freezing the global namespace objects that hosts
 * legitimately mutate (e.g. `console`, `globalThis`) unless explicitly asked.
 */
function getIntrinsicTargets(): ReadonlyArray<readonly [string, unknown]> {
  // Built via a fresh array each call (immutability: never mutate a shared list).
  // Access well-known globals defensively; some may be absent on exotic runtimes.
  const g = globalThis as unknown as Record<string, unknown>;

  const candidates: Array<readonly [string, unknown]> = [
    ["Object", Object],
    ["Object.prototype", Object.prototype],
    ["Function", Function],
    ["Function.prototype", Function.prototype],
    ["Array", Array],
    ["Array.prototype", Array.prototype],
    ["String", String],
    ["String.prototype", String.prototype],
    ["Number", Number],
    ["Number.prototype", Number.prototype],
    ["Boolean", Boolean],
    ["Boolean.prototype", Boolean.prototype],
    ["Symbol", Symbol],
    ["Symbol.prototype", Symbol.prototype],
    ["BigInt.prototype", (g.BigInt as { prototype?: unknown })?.prototype],
    ["RegExp", g.RegExp],
    ["RegExp.prototype", (g.RegExp as { prototype?: unknown })?.prototype],
    ["Date", g.Date],
    ["Date.prototype", (g.Date as { prototype?: unknown })?.prototype],
    ["Error", Error],
    ["Error.prototype", Error.prototype],
    ["Map", Map],
    ["Map.prototype", Map.prototype],
    ["Set", Set],
    ["Set.prototype", Set.prototype],
    ["WeakMap.prototype", WeakMap.prototype],
    ["WeakSet.prototype", WeakSet.prototype],
    ["Promise", Promise],
    ["Promise.prototype", Promise.prototype],
    ["JSON", JSON],
    ["Math", Math],
    ["Reflect", Reflect],
  ];

  return candidates.filter(
    (entry): entry is readonly [string, object] =>
      entry[1] !== undefined && entry[1] !== null,
  );
}

/**
 * Freeze a single intrinsic, recording success/failure. Best-effort: any throw
 * (e.g. a host that made an intrinsic non-configurable in an odd way) is caught
 * and reported instead of aborting the whole pass.
 */
function freezeOne(
  path: string,
  value: unknown,
  frozen: string[],
  failures: string[],
  onFailure?: (path: string, reason: string) => void,
): void {
  try {
    if (
      (typeof value === "object" || typeof value === "function") &&
      value !== null &&
      !Object.isFrozen(value)
    ) {
      Object.freeze(value);
    }
    if (Object.isFrozen(value)) {
      frozen.push(path);
    } else {
      failures.push(path);
      onFailure?.(path, "Object.freeze did not take effect");
    }
  } catch (e) {
    failures.push(path);
    onFailure?.(path, e instanceof Error ? e.message : "unknown freeze error");
  }
}

/**
 * Apply the browser secondary defense: freeze JavaScript intrinsics so the
 * shared realm cannot be mutated to mount a prototype-pollution or
 * intrinsic-hijacking escape.
 *
 * This is OPT-IN. Hosts that embed ag-bash in a browser and want Node-parity
 * secondary depth should call this ONCE, as early as possible (before any
 * untrusted code or any `bash.exec()`), typically right after import:
 *
 * ```ts
 * import { Bash, hardenBrowserGlobals } from "@ag-bash/bash/browser";
 * hardenBrowserGlobals();
 * const bash = new Bash();
 * ```
 *
 * Characteristics:
 * - Idempotent: safe to call multiple times; only the first call does work.
 * - Non-destructive: only flips writability/extensibility via `Object.freeze`;
 *   it never replaces or deletes any value, so no behavior is silently swapped.
 * - Fail-open per-intrinsic: a freeze that cannot be applied is reported in
 *   `failures` rather than throwing, so legitimate use is never broken.
 *
 * Pair this with a strict Content-Security-Policy that forbids inline/eval'd
 * script (see SECURITY.md) for true defense-in-depth at the browser layer.
 *
 * @param options - Optional hardening tuning. See {@link BrowserHardeningOptions}.
 * @returns Immutable {@link BrowserHardeningResult} describing the pass.
 */
export function hardenBrowserGlobals(
  options?: BrowserHardeningOptions,
): BrowserHardeningResult {
  if (hardeningApplied && lastResult) {
    return { ...lastResult, firstRun: false };
  }

  const frozen: string[] = [];
  const failures: string[] = [];
  const onFailure = options?.onFailure;

  for (const [path, value] of getIntrinsicTargets()) {
    freezeOne(path, value, frozen, failures, onFailure);
  }

  if (options?.freezeGlobalThis === true) {
    freezeOne("globalThis", globalThis, frozen, failures, onFailure);
  }

  hardeningApplied = true;
  const result: BrowserHardeningResult = {
    applied: true,
    firstRun: true,
    frozen: Object.freeze([...frozen]),
    failures: Object.freeze([...failures]),
  };
  lastResult = result;
  return result;
}

/**
 * Report whether {@link hardenBrowserGlobals} has been applied in this realm.
 */
export function isBrowserHardened(): boolean {
  return hardeningApplied;
}

/**
 * Test-only: reset the module guard. Does NOT un-freeze anything (freezing is
 * irreversible); it only clears the bookkeeping flag so a fresh
 * `hardenBrowserGlobals()` call re-reports `firstRun: true`. Used by the test
 * suite to assert idempotency behavior deterministically.
 */
export function __resetBrowserHardeningForTests(): void {
  hardeningApplied = false;
  lastResult = null;
}
