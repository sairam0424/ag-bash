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

> [!IMPORTANT]
> **Two controls documented in earlier releases are NOT enforced in 6.1.** Do not
> rely on either; both are labelled in `THREAT_MODEL.md` and targeted for 7.0.
>
> - **Plan mode is not a security boundary.** It blocks command-layer writes
>   (`touch`, `rm`, `tee`) but a shell redirection — `echo x > file` — writes
>   through it. For a confined session use `new OverlayFs({ root, readOnly: true })`;
>   that boundary *is* enforced (`EROFS` on every write path, redirections
>   included). Note `InMemoryFs` is **not** a read-only VFS — it has no
>   `readOnly` option and accepts writes — and dropping the writable overlay is
>   not sufficient either, since `OverlayFs` always keeps an in-memory layer.
>   A refused write currently rejects the `exec()` promise rather than returning a
>   non-zero result, so wrap it in `try/catch`. (`THREAT_MODEL.md` TB7.)
> - **`ag-convert` is not WASM-sandboxed.** It spawns **host** `python3` with the
>   full parent environment (`{ ...process.env }`) and is registered by default.
>   The `python3` builtin *is* WASM-sandboxed; `ag-convert` is a different path.
>   (`THREAT_MODEL.md` TB8.)

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

## 4. Runtime launch hardening (Node.js CLI / MCP server) — ADVISORY

> [!WARNING]
> **This section is ADVISORY, not a supported configuration.** ag-bash's CI does
> not run under these flags, and enabling the Permission Model **disables shipped
> features** — see §4.3. Read §4.1 and §4.3 before copying anything here into a
> deployment.
>
> The previous revision of this section recommended
> `node --frozen-intrinsics --disallow-code-generation-from-strings --permission --allow-child-process=false ./dist/bin/ag-bash.js`
> as a drop-in. That invocation is wrong twice over: it **does not start**
> (`ERR_ACCESS_DENIED`, `permission: 'FileSystemRead'` — the Permission Model
> denies reading the CLI's own chunk files), and `--allow-child-process=false`
> **grants** child-process access rather than denying it (§4.2). It has been
> replaced.

### 4.1 What these flags are, and what they are not

These flags constrain the **host process**. None of them is a sandbox, and none of
them is what confines an untrusted bash script — that is the architectural
boundary in §2 plus the VFS and network allow-list. Treat this section as
belt-and-braces for the operator, not as a security control you can point an
auditor at.

Explicit non-guarantees:

- **The Node.js Permission Model is not a sandbox, by Node's own definition.**
  Quoting the Node.js documentation verbatim: *"The permission model implements a
  "seat belt" approach, which prevents trusted code from unintentionally changing
  files or using resources that access has not explicitly been granted to. It does
  not provide security guarantees in the presence of malicious code. Malicious
  code can bypass the permission model and execute arbitrary code without the
  restrictions imposed by the permission model."* The same page notes *"This
  feature does not protect against malicious code"* and *"The model does not
  inherit to a worker thread"* — the latter matters here, because ag-bash's WASM
  runtimes (`python3`, `js-exec`, `sqlite3`) each run in a `node:worker_threads`
  Worker.
- **ag-bash cannot enable `--frozen-intrinsics` on your behalf.** It has **no
  programmatic API** — it is a startup-only CLI flag (settable via `NODE_OPTIONS`
  or a Node config file, but never from library code). A dependency cannot turn it
  on for a consumer. It is also `Stability: 1 - Experimental`, documented as
  *"Only the root context is supported… Code may break under this flag."*
- **`--disallow-code-generation-from-strings` does not cover `node:vm`.** Node
  documents the exclusion explicitly: *"This does not affect the Node.js
  `node:vm` module."* Verified on Node v26.5.0 — with the flag set, `eval("1+1")`
  throws `EvalError`, while `vm.runInNewContext("1+41")`, `vm.compileFunction(…)`,
  and `new vm.Script(…).runInThisContext()` all return normally. It is therefore
  **not** equivalent to a CSP without `'unsafe-eval'` (§3.3), which blocks code
  generation at the engine level with no such carve-out.

### 4.2 Corrected invocation

To deny child processes under the Permission Model you **omit** the grant flag —
`--allow-child-process` is a pure *grant*, so any form of its presence
(`--allow-child-process`, `=true`, `=false`, `=0`) turns the permission **on**.
Node itself warns about this: `SecurityWarning: The flag --allow-child-process
must be used with extreme caution. It could invalidate the permission model.`
Measured on Node v26.5.0:

| Invocation | `child_process.spawnSync` |
| --- | --- |
| `--permission` | **DENIED** (`ERR_ACCESS_DENIED`) ← what you want |
| `--permission --no-allow-child-process` | DENIED (explicit, redundant) |
| `--permission --allow-child-process` | ALLOWED |
| `--permission --allow-child-process=false` | **ALLOWED** ← the old recipe's bug |
| `--permission --allow-child-process=true` | ALLOWED |

A launch line that actually starts must also grant reads for the code it loads.
The following was verified to start and execute on Node v26.5.0 —
`PKG` is the installed package root (`…/node_modules/@ag-bash/bash`), `WS` is
your workspace:

```bash
node \
  --frozen-intrinsics \
  --disallow-code-generation-from-strings \
  --permission \
  --allow-fs-read="$PKG/*" \
  --allow-fs-read="$WS" \
  --allow-fs-write="$WS" \
  "$PKG/dist/bin/ag-bash.js"
# echo 'echo hello' | … → hello
```

> The read grant has to cover the **whole package root**, not just `dist/`.
> `--allow-fs-read="$PKG/dist/*"` alone still dies with
> `Fatal error: Access to this API has been restricted` — the CLI's module graph
> and vendored WASM resolution reach outside `dist/`. The exact minimal grant is
> install-layout- and version-dependent, so **validate your own launch line by
> actually running it** rather than trusting a copied one. That is precisely the
> failure the previous revision of this section shipped.

`child_process`, `worker_threads`, and addons are denied because they are not
granted (verified: under `--permission` with no grant,
`child_process.spawnSync` throws `ERR_ACCESS_DENIED`). Scope the two
`--allow-fs-*` paths to the narrowest tree the workload needs;
`--allow-fs-read='*'` re-opens the whole host filesystem to `node:fs` and defeats
the point. Note also that under the Permission Model *"Symbolic links will be
followed even to locations outside of the set of paths that access has been
granted to"* — ag-bash's own VFS default-denies symlinks
(`THREAT_MODEL.md` §3.3); the Permission Model does not.

### 4.3 Compatibility: what each flag disables

**A hardening recipe that silently breaks shipped features is worse than no
recipe.** Check this table against your feature usage first.

| Flag | Breaks | Why |
| --- | --- | --- |
| `--permission` (no `--allow-child-process`) | **`ag-convert`** | Spawns host `python3` (`commands/ag-convert/ag-convert.ts:205`) → `ERR_ACCESS_DENIED`. See THREAT_MODEL TB8 — for most threat models breaking this is a *feature*. |
| `--permission` (no `--allow-child-process`) | **MCP stdio client** (`ag-mcp`, `@ag-bash/mcp-server` connecting outward) | `spawn()` of the server process (`services/McpClient.ts:205`). HTTP-transport MCP servers are unaffected. |
| `--permission` (no `--allow-child-process`) | **LSP integration** | `spawn()` of the language server (`lsp/LSPConnection.ts:1`). |
| `--permission` (no `--allow-worker`) | **WASM runtimes: `python3`, `js-exec`, `sqlite3`** | Each runs in a `node:worker_threads` Worker. Add `--allow-worker` if you need them — and note Node's *"The model does not inherit to a worker thread"*, so the Worker itself is then unconstrained. |
| `--permission` (no `--allow-fs-read`) | **Process startup** | Node cannot read the CLI's own module graph. This is why the old recipe failed to launch. |
| `--permission` (no `--allow-fs-read` / `--allow-fs-write` for the mount) | **Host-backed VFS: `OverlayFs`, `ReadWriteFs`, `MountableFs`** | These go through `node:fs`. `InMemoryFs` is unaffected. |
| `--frozen-intrinsics` | Host code that patches built-ins at import time | Experimental; validate against your whole dependency set. Use `--require`/`--import` for polyfills — both run *before* freezing. |
| `--disallow-code-generation-from-strings` | Host code using `eval` / `new Function` (some template engines, some bundler dev servers) | ag-bash core does not need either. `node:vm` keeps working — see §4.1. |

### 4.4 Other notes

- These flags must be passed to the `node` binary directly (not via an npm script
  that re-execs). All of `--frozen-intrinsics`,
  `--disallow-code-generation-from-strings`, `--permission`,
  `--allow-child-process`, `--allow-fs-read`, `--allow-fs-write`, and
  `--allow-worker` are present in `process.allowedNodeEnvironmentFlags`, so
  `NODE_OPTIONS` works too.
- Node's Permission Model is also configurable from a config file
  (`"permission": { "allow-child-process": false, … }`). In *that* form `false`
  does withhold the grant — unlike the CLI `=false` in §4.2. If you prefer
  boolean-shaped config, use the config file, not the flag.

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

Enforced controls — rely on these:

- [ ] Use the narrowest VFS that works: `InMemoryFs` if the workload needs no host
      files. Grant filesystem/network access only through ag-bash's VFS and
      network allow-list, never the host's ambient authority.
- [ ] Keep `defenseInDepth` enabled (the v5.0.0+ default) for `bash.exec()`.
- [ ] Browser: call `hardenBrowserGlobals()` once at startup.
- [ ] Browser: serve under a strict CSP without `'unsafe-eval'` / `'unsafe-inline'`.

Not enforced in 6.1 — do **not** rely on these:

- [ ] Do **not** use plan mode as a confinement mechanism (`THREAT_MODEL.md` TB7).
      Use a read-only VFS instead.
- [ ] Decide explicitly about `ag-convert`: it is registered by default and spawns
      host `python3` with the parent environment (`THREAT_MODEL.md` TB8). If you do
      not need document conversion, do not mount a host directory it could read,
      or launch without a `child_process` grant (§4.3).

Advisory (§4) — read the compatibility table first:

- [ ] Node CLI/MCP: consider `--frozen-intrinsics
      --disallow-code-generation-from-strings --permission` plus narrowly scoped
      `--allow-fs-read` / `--allow-fs-write`. **Omit** `--allow-child-process`
      entirely to deny child processes — `=false` grants it (§4.2). Note this
      disables `ag-convert`, MCP stdio clients, and LSP (§4.3).
