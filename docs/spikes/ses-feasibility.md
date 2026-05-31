# Spike: Full SES `lockdown()` for the ag-bash Sandbox — Feasibility & Decision

- **Status:** Decision memo (no code migration in this spike)
- **Stream:** 5-SES (`chore/v6-cleanup-and-spikes`)
- **Scope:** Should ag-bash adopt full SES (Secure EcmaScript) `lockdown()` /
  Compartments as its sandbox hardening layer, and how does that collide with
  the repo's banned-pattern CI gate?
- **TL;DR recommendation:** **Do not adopt full SES now.** Keep the existing
  `Object.freeze` intrinsic-freeze (`hardenBrowserGlobals()` /
  `--frozen-intrinsics`) as the secondary layer. SES's benefit is marginal over
  what we already ship because ag-bash has **no bash→JS escape hatch** (the
  primary defense), while its cost (runtime dep, ~changed global semantics,
  startup + bundle cost, and a direct collision with our banned-pattern gate) is
  high. Revisit only if we ever execute **host-supplied JavaScript** in-realm.

---

## 1. Problem statement

The v6 hardening work added a *lighter* secondary defense — freezing JS
intrinsics via `Object.freeze` — and explicitly deferred full SES as a
"documented follow-up" (SECURITY.md:88-92, `browser-hardening.ts:23-32`). This
spike decides whether that follow-up is worth pursuing, and resolves an open
tension: **the `ses` shim and `lockdown()` historically rely on exactly the
primitives our CI gate bans** (`eval` / `new Function` / `Proxy` / dynamic
`import()` / `setPrototypeOf` / global-constructor mutation). We need a clear
answer on (a) security value-add over the status quo, (b) cost, and (c) whether
the `src/security/` scanner exemption is sufficient to host SES without
weakening the gate elsewhere.

---

## 2. Current state (file:line evidence)

### 2.1 Two-tier defense model

- **Primary defense (architectural):** ag-bash lexes → parses → interprets bash;
  there is **no path from a bash command to `eval`/`Function`**. This is stated
  as the load-bearing control in `browser-hardening.ts:13-17`. SES protects a
  *shared JS realm* from untrusted *JS*; ag-bash does not run untrusted JS in
  the realm, so the threat SES addresses is largely out of band.

- **Secondary defense, Node (main thread):** `DefenseInDepthBox` monkey-patches
  dangerous globals scoped to a `bash.exec()` async context via
  `node:async_hooks` `AsyncLocalStorage` (`defense-in-depth-box.ts:1-30`,
  `66-88`). It blocks `Function`, `eval`, `setTimeout(string)`, and selected
  `process.*` members (`blocked-globals.ts:68-227`). Dynamic `import()` is
  mitigated in three layers (loader hooks for `data:`/`blob:`/builtins,
  `Module._resolveFilename`, and FS restrictions) — `defense-in-depth-box.ts:19-29`.

- **Secondary defense, Worker threads:** `WorkerDefenseInDepth` — an
  AsyncLocalStorage-free variant that *always* blocks (no context) for WASM
  worker contexts (`index.ts:60-64`).

- **Secondary defense, Browser:** `AsyncLocalStorage` does not exist in
  browsers, so `DefenseInDepthBox` is a no-op there and the browser bundle ships
  `Function`/`eval`/`Proxy` **live** (`browser-hardening.ts:7-11`). To restore
  Node parity, `hardenBrowserGlobals()` freezes intrinsics
  (`browser-hardening.ts:95-229`). It is:
  - **opt-in** (never auto-runs; exported from `browser.ts:56-60`, called
    nowhere in `src/` non-test code),
  - **non-destructive** (only flips writability/extensibility via
    `Object.freeze`; never replaces/deletes a value — `browser-hardening.ts:146-171`),
  - **idempotent / fail-open per intrinsic** (`browser-hardening.ts:204-228`).

- **Node-native equivalent already documented:** SECURITY.md:128-145 already
  recommends launching the CLI/MCP with `--frozen-intrinsics`
  `--disallow-code-generation-from-strings` `--permission`
  `--allow-child-process=false`. `--disallow-code-generation-from-strings` is
  the engine-level hard backstop that makes `eval`/`new Function` throw
  process-wide — i.e. **the V8 engine already gives us most of SES's
  code-generation guarantee for free, with zero dependency.**

### 2.2 The banned-pattern CI gate

- The gate is `scripts/check-banned-patterns.js`, wired as
  `lint:banned` → part of `lint` → part of `validate`
  (`packages/bash/package.json:95,98,100`).
- It bans the precise primitives SES relies on internally:
  - `eval()` — `check-banned-patterns.js:211-221`
  - `new Function()` — `:222-232`
  - `Proxy.revocable()` — `:233-245`
  - global `Function`/`eval`/`Proxy` shadowing/deletion — `:246-259`
  - dynamic `import()` with non-literal specifier — `:260-272`
  - dynamic `require()` / `createRequire` / `Module._load` — `:273-313`
  - `Object/Reflect.setPrototypeOf` — `:387-399`
  - `__proto__` / `constructor.prototype` access — `:330-356`
- **`src/security/` is exempt** (confirmed): `SKIP_PATTERNS` includes
  `/src\/security\//` at `check-banned-patterns.js:553`, with the comment
  "Security module intentionally references blocked patterns." Test files are
  also exempt (`:549-557`). This is why `blocked-globals.ts:68` can carry a
  `@banned-pattern-ignore` and reference `Function`/`eval` for *blocking*.

### 2.3 Dependency / build facts

- `ses` is **not** a dependency anywhere (absent from all `package.json` and
  `pnpm-lock.yaml`).
- Node engine floor is `>=20.6.0` (`packages/bash/package.json:168`) — modern
  enough for `--frozen-intrinsics` and Web Crypto.
- The browser bundle is already **~2.36 MB** unminified-source-bundled
  (`dist/bundle/browser.js`); SES adds materially on top.
- Builds are esbuild bundles per target (`packages/bash/package.json:88-93`),
  with `direct-eval` warnings already silenced — relevant because SES's shim
  trips bundler eval/`Function` heuristics.

---

## 3. What `lockdown()` actually provides vs. our current freeze

| Capability | `hardenBrowserGlobals()` / `--frozen-intrinsics` (status quo) | SES `lockdown()` |
| --- | --- | --- |
| Freeze intrinsic prototypes/constructors | Yes (`Object.freeze`, `browser-hardening.ts:95-139`) | Yes (transitive "harden") |
| Block `eval`/`new Function` | Via CSP (browser) / `--disallow-code-generation-from-strings` (Node) / DefenseInDepthBox patch (Node exec scope) | Yes, via `Compartment` with no `eval` endowment |
| Tame `Date`/`Math.random`/`Error` to remove ambient nondeterminism + stack leakage | **No** (deliberately not done) | **Yes** (this is the differentiator) |
| Isolated evaluation realm for *running untrusted JS* (Compartments) | No | **Yes** (its core purpose) |
| Per-`exec()` async-context scoping | Yes (Node, via AsyncLocalStorage) | No — `lockdown()` is **process-wide and irreversible** |
| Runtime dependency | None | `ses` package |

Key insight: the **only** capabilities SES adds that we do not already have are
(a) `Date`/`Math`/`Error` taming and (b) Compartment-isolated evaluation of
untrusted JS. We run **no untrusted JS in the host realm**, so (b) is unused.
(a) is a real but **secondary** hardening of an already-secondary layer.

`node:vm` is **not** a substitute either: `vm` contexts share intrinsics with
the parent realm by default and are widely documented as *not* a security
boundary — it would be a downgrade, not an alternative.

---

## 4. Options

### Option A — Full SES `lockdown()` (+ Compartments) realm-wide

- **Pros:**
  - Gold-standard transitive intrinsic hardening; tames `Date`/`Math`/`Error`
    (removes the residual ambient-nondeterminism / stack-leak surface the
    current freeze leaves).
  - Single, well-audited library replaces hand-rolled freeze + monkey-patch.
- **Cons:**
  - **Changes global semantics** for any host sharing the realm — frozen
    `Date`, tamed `Math.random` determinism shims, `Error` taming — explicitly
    flagged as breaking in SECURITY.md:88-92 and `browser-hardening.ts:24-29`.
    ag-bash is an *embeddable library*; we do not own the host realm.
  - **Process-wide & irreversible:** incompatible with our per-`exec()`
    AsyncLocalStorage scoping model (`defense-in-depth-box.ts:13-17`). We would
    lose context-scoped blocking, the design centerpiece of the Node layer.
  - **Bundle + startup cost:** adds the `ses` shim to an already ~2.36 MB
    browser bundle and a non-trivial `lockdown()` startup pass on every load.
  - **Direct CI-gate collision** (see §5).
  - **Marginal value:** primary defense (no bash→JS path) already neutralizes
    the SES threat model.
- **Effort:** High (multi-week): dep add, realm-model rewrite, reconcile with
  AsyncLocalStorage scoping + worker variant, scanner reconciliation, full
  re-validation of the security test corpus (`defense-in-depth-*`, `attacks/`,
  `fuzzing/`, `prototype-pollution/`).
- **Risk:** High (breaks host realms; large surface change to the security core).

### Option B — Partial SES confined to `src/security/` (the exempt dir)

Use only SES's `harden()` (transitive freeze) — **not** realm-wide
`lockdown()` — invoked from `src/security/` to replace/augment the
`Object.freeze` walk in `browser-hardening.ts`. Keep monkey-patch + CSP +
`--frozen-intrinsics` for code-generation blocking.

- **Pros:**
  - Better-than-shallow freeze (transitive `harden` follows own-property graphs
    that our flat `getIntrinsicTargets()` list may miss).
  - Confining the import to `src/security/` means the banned-pattern scanner
    does **not** flag the SES internals it pulls in (exemption at
    `check-banned-patterns.js:553`) — see §5 for the caveat.
- **Cons:**
  - `ses`'s public surface is `lockdown()`; using `harden()` standalone without
    `lockdown()` is partially supported and still drags the full shim into the
    bundle (no real size win).
  - Still adds a runtime dependency for a marginal freeze-quality gain.
  - The exemption only covers *our* `src/security/*.ts`; SES code lives in
    `node_modules/ses` (already skipped by `SKIP_DIRS`), so the gate is not the
    real blocker for the import — but our *wrapper* would need the exempt dir.
- **Effort:** Medium (dep add + rewrite of the freeze pass + re-validate
  `browser-hardening.test.ts`, `symbol-locking.test.ts`,
  `defense-in-depth-hardening.test.ts`).
- **Risk:** Medium (bundle weight; behavior drift in the freeze semantics that
  the existing test corpus pins).

### Option C — Status quo (recommended): keep `Object.freeze` + monkey-patch + CSP/flags

- **Pros:**
  - **Zero new dependency**, zero bundle growth, zero startup tax.
  - Preserves per-`exec()` AsyncLocalStorage scoping and the worker variant.
  - **Zero CI-gate friction** — no SES internals to reconcile.
  - Already documents the Node-native hard backstop
    (`--disallow-code-generation-from-strings`, SECURITY.md:128-145) that
    delivers SES's main code-gen guarantee at the engine level.
  - Non-destructive, fail-open, idempotent (`browser-hardening.ts:188-228`) —
    safe for an embeddable library that does not own the host realm.
- **Cons:**
  - No `Date`/`Math`/`Error` taming (residual ambient nondeterminism / possible
    stack-detail leakage in the freeze-only layer).
  - Freeze is a flat curated list (`browser-hardening.ts:100-133`), not a
    transitive graph walk — a deep, less-common intrinsic could be missed.
- **Effort:** None (document the decision; optionally extend the freeze list).
- **Risk:** Low.

---

## 5. The banned-pattern conflict, and whether `src/security/` exemption resolves it

**The conflict is real.** The `ses` shim and `lockdown()` legitimately use, in
its own source: `Function`/`eval` probing, `Proxy`-based taming, and prototype
manipulation — the exact set the gate bans
(`check-banned-patterns.js:211-272,330-399`).

**What the exemption does and does not solve:**

1. **SES library source is already not scanned.** The scanner skips
   `node_modules` via `SKIP_DIRS` (`check-banned-patterns.js:531-540`). So SES's
   *own* internal use of these primitives never reaches the gate regardless of
   the `src/security/` exemption. The gate is **not** a blocker to merely
   *depending on* `ses`.

2. **Our SES *wrapper* would need the exemption.** Any first-party glue that
   calls `lockdown()` / `harden()` and necessarily references
   `Function`/`eval`/`Proxy`/prototype APIs must live under `src/security/`
   to be skipped (`SKIP_PATTERNS` at `:553`). This is exactly how
   `blocked-globals.ts:68` already references `Function`/`eval` under a
   `@banned-pattern-ignore`. So **placement under `src/security/` does resolve
   the gate collision for our own wrapper code.**

3. **But the exemption does not make SES *safe* to adopt — it only silences the
   linter.** The gate exists to prevent dynamic-code primitives from leaking
   into *runtime command/interpreter paths*. SES does not reduce that risk for
   us; it relocates a class of powerful primitives into the realm. The exemption
   is an *escape hatch for trusted hardening internals*, not an endorsement.
   Adopting SES purely because "the exempt dir hides it from the scanner" is
   inverted reasoning: the gate is a symptom-detector, and we would be
   suppressing it for a feature whose benefit (over status quo) is marginal.

**Conclusion on the collision:** The `src/security/` exemption (line 553) is
*sufficient* to host an SES wrapper without weakening the gate elsewhere — the
gate would not block Options A or B. The collision is therefore **not the
deciding factor**. The deciding factors are the realm-semantics breakage,
process-wide irreversibility vs. our scoped model, bundle/startup cost, and the
marginal security delta given the primary architectural defense.

---

## 6. Recommendation

**Adopt Option C (status quo). Do not pursue full SES `lockdown()` for v6.**

Rationale:

1. The threat SES neutralizes (untrusted JS mutating a shared realm) is already
   neutralized by the **primary** architectural control — no bash→JS escape
   hatch (`browser-hardening.ts:13-17`).
2. SES's only true delta over what we ship — `Date`/`Math`/`Error` taming and
   Compartment isolation — is either unused (Compartments) or a marginal
   hardening of an *already secondary* layer.
3. `lockdown()` is process-wide and irreversible, which is fundamentally at
   odds with our per-`exec()` AsyncLocalStorage scoping and inappropriate for an
   embeddable library that does not own the host realm
   (SECURITY.md:88-92; `defense-in-depth-box.ts:13-17`).
4. The Node-native `--disallow-code-generation-from-strings` +
   `--frozen-intrinsics` flags (SECURITY.md:128-145) and the browser CSP
   already deliver SES's headline code-generation guarantee with **zero**
   dependency, bundle, or CI-gate cost.

**Concrete follow-ups (cheap, within status quo):**

- Keep the SES note in SECURITY.md but **update it from "planned follow-up" to
  "evaluated and declined for v6 — see `docs/spikes/ses-feasibility.md`"** so
  the deferral is a recorded decision, not an open TODO. *(SECURITY.md is owned
  by another stream / the LEAD — flag, do not edit here.)*
- Optionally strengthen the existing freeze cheaply: extend
  `getIntrinsicTargets()` (`browser-hardening.ts:100-133`) toward a transitive
  walk (e.g. include `TypedArray`/`%IteratorPrototype%`/`GeneratorFunction`
  prototypes) to capture the "flat list misses a deep intrinsic" gap **without**
  taking the `ses` dependency.

**Reopen criteria — adopt SES only if** ag-bash gains a feature that executes
**host- or user-supplied JavaScript in the host realm** (e.g. a JS plugin/eval
command outside the existing QuickJS-WASM worker isolate). At that point
Compartments become load-bearing rather than marginal, and the cost/benefit
inverts. Until then, SES is cost without commensurate benefit.
