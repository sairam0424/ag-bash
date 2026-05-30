# Security Policy

Ag-Bash is an AI-native, sandboxed bash interpreter. This document describes
its security model and the hardening levers available to embedders. It covers
three layers:

1. The **primary architectural defense** (no bash → JavaScript escape path).
2. The **secondary defense-in-depth layer** (Node.js and browser).
3. **Supply-chain** and **runtime launch** hardening for operators.

> Defense-in-depth note: the secondary layers below exist to contain *bugs* in
> ag-bash itself or in host-supplied custom commands. They are not the primary
> control. The primary control is architectural: a bash script is lexed,
> parsed, and interpreted — there is no code path from a bash command to
> `eval` / `Function` / dynamic `import()`.

---

## 1. Reporting a vulnerability

Please report security issues privately to the project maintainers rather than
opening a public issue. Treat any leaked credential as compromised and rotate
it immediately.

---

## 2. Primary defense: no bash → JS escape

ag-bash never converts a bash script into JavaScript and never evaluates script
text as code. Commands are dispatched through a typed `BashHost` interface to
builtin implementations. This holds identically in Node.js and in the browser
bundle.

---

## 3. Secondary defense-in-depth

### 3.1 Node.js (automatic)

In Node.js builds, `DefenseInDepthBox` (`src/security/defense-in-depth-box.ts`)
monkey-patches dangerous globals (`Function`, `eval`, `Module._load`,
`process.*`, dynamic `import()` of `data:`/`blob:`/builtins, the
`.constructor.constructor` chain, well-known Symbols, `Proxy.revocable`, …)
*only* within the `AsyncLocalStorage` context of an active `bash.exec()`. It is
**enabled by default** in v5.0.0+. Concurrent, non-sandboxed code in the same
process is unaffected.

### 3.2 Browser (opt-in)

`AsyncLocalStorage` does not exist in browsers, so the entire
`DefenseInDepthBox` is a **no-op** in browser builds — the `__BROWSER__` define
makes every guard early-return. As a result the browser bundle ships
`Function`/`eval`/`Proxy` fully live. The primary architectural defense still
holds (there is still no bash → JS path), but the secondary depth layer is
absent **unless you opt in**.

To restore Node-parity secondary depth in the browser, call
`hardenBrowserGlobals()` **once**, as early as possible (before any
`bash.exec()` and before any untrusted code runs):

```ts
import { Bash, hardenBrowserGlobals } from "@ag-bash/bash/browser";

// Freeze JS intrinsics (Object/Function/Array/... prototypes + constructors)
// so a future bug or a malicious host custom command cannot mutate the shared
// realm to mount prototype-pollution or intrinsic-hijacking.
hardenBrowserGlobals();

const bash = new Bash();
```

Characteristics of `hardenBrowserGlobals()`:

- **Opt-in.** It does not run automatically — freezing intrinsics is a one-way,
  realm-wide operation and can break hosts that lazily patch built-ins.
- **Non-destructive.** It only flips writability/extensibility via
  `Object.freeze`; it never replaces or deletes any value, so no behavior is
  silently swapped.
- **Idempotent.** Safe to call repeatedly; only the first call does work.
- **Fail-open per intrinsic.** A freeze that cannot be applied is reported in
  the returned `failures` array (and via the optional `onFailure` callback)
  rather than throwing — legitimate use is never broken.
- `freezeGlobalThis: true` additionally seals `globalThis` (strictest; can break
  polyfills that attach globals lazily).

Use `isBrowserHardened()` to check whether the pass has run.

> **SES follow-up.** Full realm isolation via the `ses` package (`lockdown()` +
> Compartments) is the gold standard but adds a runtime dependency and changes
> global semantics (taming `Date`, `Math`, `Error`, etc.), which can break host
> code sharing the realm. Per the v6.0.0 risk posture we ship the lighter
> intrinsic-freeze and track SES integration as a documented follow-up.

### 3.3 Browser Content-Security-Policy (required for true depth)

`hardenBrowserGlobals()` closes the *mutation* surface; a strict CSP closes the
*code-generation* surface. Pair them. Serve the page hosting ag-bash with a CSP
that forbids inline and `eval`'d script:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  object-src 'none';
  base-uri 'none';
  frame-ancestors 'none';
```

Notes:

- **Do not** add `'unsafe-eval'` or `'unsafe-inline'` to `script-src`. With
  `'unsafe-eval'` absent, the browser refuses `eval`/`new Function`/`setTimeout`
  -with-string-body at the engine level — a hard backstop for the live
  `Function`/`eval` the browser bundle ships.
- Use `object-src 'none'` and `base-uri 'none'` to block plugin and `<base>`
  hijack vectors.
- If you must run ag-bash inside a worker, set the same CSP via the
  `Content-Security-Policy` response header on the worker script.

---

## 4. Runtime launch hardening (Node.js CLI / MCP server) — E4

When running the ag-bash CLI or the MCP server binary, launch Node with its own
hardening flags so the *host process* is constrained even if a sandbox escape
were attempted. Recommended invocation:

```bash
node \
  --frozen-intrinsics \
  --disallow-code-generation-from-strings \
  --permission \
  --allow-child-process=false \
  ./dist/bin/ag-bash.js
```

| Flag | Effect |
| --- | --- |
| `--frozen-intrinsics` | Freezes all JS intrinsics at startup (the Node-native equivalent of `hardenBrowserGlobals()`), blocking prototype-pollution / intrinsic-hijack. |
| `--disallow-code-generation-from-strings` | Makes `eval` and `new Function` throw process-wide — a hard backstop matching the browser CSP `script-src` recommendation. |
| `--permission` | Enables the Node.js Permission Model (deny-by-default for fs / child_process / worker / addons unless explicitly granted). |
| `--allow-child-process=false` | Explicitly denies spawning child processes (`child_process`), neutralizing the most valuable escape target. Add `--allow-fs-read=`/`--allow-fs-write=` to grant only the directories the workload needs. |

> Caveats:
> - `--frozen-intrinsics` is marked experimental in some Node versions and can
>   conflict with libraries that patch built-ins at import time. Validate against
>   your dependency set before enabling in production.
> - The Permission Model intercepts `fs`, `child_process`, `worker_threads`, and
>   native addons; grant the minimum the workload needs via `--allow-fs-read` /
>   `--allow-fs-write` allowlists rather than enabling broadly.
> - These flags must be passed to the `node` binary directly (not via npm
>   scripts that re-exec), or set through `NODE_OPTIONS` where the flag is
>   permitted there.

---

## 5. Supply-chain posture — E3

- **Audit gates the build.** CI runs `pnpm audit --audit-level=high` with **no**
  `continue-on-error`; a high/critical advisory fails the `Quality` workflow.
  When a transitive advisory lands, pin the patched version via the
  `pnpm.overrides` block in the root `package.json` (see the
  `fast-xml-builder` / `sanitize-html` entries) rather than suppressing the
  gate.
- **Provenance on publish.** The `Publish` workflow publishes with
  `npm publish --provenance` using GitHub OIDC (`id-token: write`), producing a
  Sigstore attestation that links each published tarball to the exact workflow,
  commit, and repository that built it. Consumers can verify with
  `npm audit signatures`.
- **Signature verification.** The publish pipeline runs `npm audit signatures`
  to verify registry signatures of installed dependencies before building.
- **Integrity-locked installs.** All CI installs use
  `pnpm install --frozen-lockfile`, so the resolved dependency graph and its
  integrity hashes cannot drift between lockfile and install.

---

## 6. Hardening checklist for embedders

- [ ] Browser: call `hardenBrowserGlobals()` once at startup.
- [ ] Browser: serve under a strict CSP without `'unsafe-eval'` / `'unsafe-inline'`.
- [ ] Node CLI/MCP: launch with `--frozen-intrinsics --disallow-code-generation-from-strings --permission --allow-child-process=false`.
- [ ] Keep `defenseInDepth` enabled (the v5.0.0+ default) for `bash.exec()`.
- [ ] Grant filesystem/network access only through ag-bash's VFS and network
      allow-list, never the host's ambient authority.
