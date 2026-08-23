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

### 5.1 The advisory gate is reachability-scoped

`node scripts/check-advisories.mjs` is the blocking supply-chain gate. It is
enforced in **five** places, none of them with `continue-on-error`:
`.github/workflows/quality.yml` (every PR and push), `release.yml`,
`publish.yml`, `canary.yml` (nightly), and `scripts/publish.sh` (the local /
manual publish path).

It reads `pnpm audit --json` and sorts every finding into one of four
reachability classes, then blocks on only two of them:

| Class | Meaning | high/critical |
| --- | --- | --- |
| `published` | the resolved `name@version` is in the production dependency closure of a non-private `packages/*` package | **fails the run** |
| `unknown root` | reachability could not be established (no version and no path, or a path root that is not a known workspace package) | **fails the run** (fails closed) |
| `root devDependency` | build-time only (`vitest`, `vite`, `esbuild`, `changesets`, …) | reported, does **not** fail |
| `examples/*` | example consumers, never published to npm | reported, does **not** fail |

Reachability is decided by exact installed `name@version` membership in that
production closure, **not** by the dependency path `pnpm audit` happens to
print: pnpm collapses `findings` to one representative path per (advisory,
version), so the printed root is arbitrary when several roots resolve the same
version. A path root is consulted only when no version is available, and an
unrecognised root is treated as blocking. The blocking severity threshold
defaults to `high` (`--level=critical` narrows it).

This replaced a bare workspace-wide `pnpm audit --audit-level=high`. That
whole-workspace visibility was **not** removed — the original command is
retained verbatim in two deliberately non-blocking places: the
`advisories-report` job in `quality.yml` and the "Whole-workspace advisory
drift (report only)" step in `canary.yml`. A red mark there with a green
`quality` job is the designed signal: a real advisory exists that no consumer
of the published packages can reach.

### 5.2 What this gate no longer catches — on the record

Narrowing the gate to what we ship gave up real coverage. Stated plainly, so
nobody reads the green check as more than it is:

- **A compromised build-time dependency now only warns.** `vitest`, `vite`,
  `esbuild` and `changesets` run on CI runners that hold publish credentials
  and on maintainer laptops, and `esbuild` bundles the shipped `dist/`. A
  hostile version of any of them is a credible path to a poisoned artifact
  *without* any advisory ever reaching the published closure — and it will not
  fail a release. This is an accepted gap, not a solved problem. It is covered
  only by the non-blocking report jobs above, plus `codeql.yml` and
  `dependency-review.yml` (which does block at the PR boundary, before a new
  dependency lands).
- **Advisories in `examples/*` no longer block.** Nothing in CI deploys them
  today (`examples.yml` is build + typecheck only), but anyone who deploys
  `examples/website` by hand is outside this gate's coverage.
- **Anything below `high`** never blocked, and still does not.

### 5.3 Fixing a blocking advisory

Pin the patched version through the `pnpm.overrides` block in the root
`package.json` (see the `fast-xml-builder` / `sanitize-html` / `esbuild` /
`brace-expansion` entries). That is the preferred fix, and the only one that
actually removes the vulnerable code.

Where no patched version exists yet, the gate accepts a **time-boxed**
exception in `auditConfig.ignoreCves` in the root `package.json`. JSON carries
no comments, so the shape is documented here instead:

```json
"auditConfig": {
  "ignoreCves": [
    {
      "id": "GHSA-xxxx-yyyy-zzzz",
      "reason": "not reachable: the parser never sees untrusted XML",
      "expires": "2026-11-30"
    }
  ]
}
```

The table currently ships **empty**: there are no active exceptions, and no
high/critical advisory reaches a published package. Every entry is validated by
`scripts/check-advisories.mjs` — that validation is the entire point of routing
waivers through this table:

- `id` is required, and matches a GHSA id, an npm advisory id, or any CVE listed
  on the advisory (`cve` and `ghsa` are accepted as aliases for the key).
- `reason` is required and must be at least 12 characters — a written
  justification for shipping the finding, not a shrug.
- `expires` is required and must be a real calendar date as `YYYY-MM-DD`
  (`2026-02-31` is rejected rather than accepted as a shape match).
- **The expiry is enforced, not decorative.** Once `expires` is in the past the
  entry stops suppressing anything, so the run fails twice over: once for the
  expired-config error, and again because the finding it used to cover
  reappears as blocking. An ignore list without an enforced expiry is exactly
  how a permanent exception gets created by accident.
- An entry that matches no finding is reported as a deletion candidate (a note,
  not a failure), so waivers do not silently outlive their advisory.

### 5.4 Other supply-chain controls

- **Provenance on publish.** The `Publish` workflow publishes with
  `npm publish --provenance` using GitHub OIDC (`id-token: write`), producing a
  Sigstore attestation that links each published tarball to the exact workflow,
  commit, and repository that built it. Consumers can verify with
  `npm audit signatures`.
- **Signature verification.** The publish pipeline runs `npm audit signatures`
  to verify registry signatures of installed dependencies before building. Be
  aware it is best-effort there: pnpm's store layout can defeat it, so a
  failure emits a `::warning::` for manual review instead of blocking the
  publish.
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
