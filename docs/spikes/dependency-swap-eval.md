# Dependency Swap Evaluation — WASM Runtimes

**Status:** Evaluation only (no swap performed this session)
**Scope:** Two WASM dependencies in `@ag-bash/bash`
1. `sql.js` → `@sqlite.org/sqlite-wasm` (official SQLite Wasm build)
2. `quickjs-emscripten` → quickjs-ng variant (`@jitl/quickjs-ng-wasmfile-release-sync`)

**Decision memo TL;DR**
- **sql.js → @sqlite.org/sqlite-wasm:** **Don't swap** (defer indefinitely). High API-rewrite cost, high security-surface change, and the headline win (size) is real but the integration risk outweighs it for a worker-isolated, sandboxed use case.
- **quickjs-emscripten → quickjs-ng:** **Swap later** (low-risk, opportunistic). This is a *variant change within the same library family*, not a library replacement — the JS API surface is identical. Effort is Small; do it alongside the next `quickjs-emscripten` version bump.

All facts below were gathered from the repo source and `npm view` on 2026-05-31.

---

## 1. sql.js → @sqlite.org/sqlite-wasm

### Current usage (file:line)

The dependency is declared in `packages/bash/package.json`:
- `"sql.js": "^1.13.0"` (line 156) — installed `1.14.1` (pnpm store).
- `"@types/sql.js": "^1.4.9"` (line 133, devDep) — installed `1.4.11`.
- Externalized in **every** esbuild step: `--external:sql.js` in `build:lib` (line 88), `build:lib:cjs` (line 89), `build:cli` (line 92), `build:shell` (line 93), and `build:worker` (line 87, the sqlite worker bundle).

Two source files import it:

`packages/bash/src/commands/sqlite3/worker.ts` (the hot path — runs inside a `node:worker_threads` worker):
- L17: `import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";`
- L79: `cachedSQL = await initSqlJs();` — module init, once per worker.
- L191: `db = new SQL.Database(data.dbBuffer);` — open from a `Uint8Array` buffer.
- L193: `db = new SQL.Database();` — `:memory:` open.
- L213: `db.run(stmt);` — write statements.
- L218: `db.prepare(stmt)` → L219 `prepared.getColumnNames()`, L222 `prepared.step()`, L223 `prepared.get()`, L226 `prepared.free()` — read path that captures column names even for empty result sets.
- L240: `db.export();` — serialize modified DB back to a `Uint8Array` for writeback to the VFS.
- L243: `db.close();`

`packages/bash/src/commands/sqlite3/sqlite3.ts` (the command impl, main thread):
- L19: `import initSqlJs from "sql.js";`
- L210: `await DefenseInDepthBox.runTrustedAsync(() => initSqlJs())` — used only for `-version` (`getSqliteVersion`).
- L211–213: `new SQL.Database()` + `db.exec("SELECT sqlite_version()")` reading `result[0].values[0][0]`.
- The rest of the file orchestrates a worker (`_internals.createWorker`, `executeInWorker`), a protocol-token handshake (`normalizeWorkerResult`), timeout termination, and VFS writeback (`ctx.fs.writeFile(dbPath, result.dbBuffer)` at L650). **None of that orchestration touches the SQLite API** — it would survive a swap unchanged.

**API surface actually used:** `initSqlJs()`, `new SQL.Database(buf?)`, `db.run`, `db.prepare → {getColumnNames, step, get, free}`, `db.export()`, `db.close()`, `db.exec()`. Confirmed against `@types/sql.js` `index.d.ts` (L60 `close`, L104 `exec`, L110 `export`, L145 `prepare`, L158 `run`, L237 `get`, L253 `getColumnNames`, L290 `step`).

### Candidate

`@sqlite.org/sqlite-wasm` — the **official** SQLite project Wasm build, maintained by the SQLite authors (npm maintainers `sgbeal` (D. Richard Hipp's team) + `tomayac`). Latest `3.53.0-build1` (published 2026-04-21). ESM-only (`"type": "module"`, `main: ./dist/index.mjs`, with a `node: ./dist/node.mjs` condition and a separately-exported `./sqlite3.wasm`).

### Compatibility assessment

**The API is fundamentally different — this is a rewrite, not a drop-in.**

| Concern | sql.js (current) | @sqlite.org/sqlite-wasm |
|---|---|---|
| Init | `initSqlJs()` → `SqlJsStatic` | `sqlite3InitModule()` → `sqlite3` namespace |
| Open in-memory | `new SQL.Database()` | `new sqlite3.oo1.DB(':memory:', 'c')` |
| Open from buffer | `new SQL.Database(uint8)` | No constructor overload; must `sqlite3.capi.sqlite3_deserialize(...)` on a fresh DB pointer (low-level capi) |
| Serialize out | `db.export(): Uint8Array` | `sqlite3.capi.sqlite3_js_db_export(db.pointer): Uint8Array` (capi, not on the OO1 object) |
| Prepared read w/ column names | `prepare → getColumnNames/step/get/free` | `db.exec({ sql, rowMode:'array', columnNames:[], callback })` or `db.prepare()` (OO1 `Stmt` with `getColumnNames`, `step`, `get`) |
| Write | `db.run(sql)` | `db.exec(sql)` |
| Module format | CJS-friendly UMD | **ESM-only** |

The buffer-open and buffer-export paths (worker.ts L191 and L240) are the load-bearing ones for VFS persistence, and they move from one-liner OO1 methods to low-level `capi`/`wasm` pointer calls. That is the bulk of the rewrite risk: getting `sqlite3_deserialize` flags right (`SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE`) and the export pointer lifecycle correct, with no behavior regression across the existing `sqlite3.*.test.ts` suites (parsing, output-modes, errors, fixtures, write-ops, worker-protocol-abuse).

**Worker-bridge / SharedStateBus integration impact:** **Low/none on the bridge itself.** The sqlite3 worker does **not** use the SharedArrayBuffer `SyncBackend`/`worker-bridge` protocol at all (that is js-exec/python only). It uses plain `workerData` in + `postMessage` out, and the message contract (`WorkerInput`/`WorkerOutput`, protocol-token wrapping, `dbBuffer: Uint8Array`) is independent of the SQLite engine. The defense-in-depth phasing (init WASM unrestricted → `new WorkerDefenseInDepth()` → run user SQL) is also engine-agnostic. **Caveat:** the official build's Emscripten module-load shape (separate `.wasm`, ESM init) needs the same "init before defense activates" treatment and may need its own esbuild externalization + `.wasm` copy rules, mirroring how the python worker externalizes `../../../vendor/cpython-emscripten/*` (package.json L87).

### WASM / package size delta

- `sql.js` unpacked: **19.1 MB** (`dist.unpackedSize = 19095444`) — includes asm.js fallbacks, debug builds, and multiple wasm variants in the published tarball.
- `@sqlite.org/sqlite-wasm` unpacked: **2.83 MB** (`dist.unpackedSize = 2829040`).
- The *shipped* `.wasm` is the relevant figure; both externalize the wasm out of the JS bundle (sql.js is `--external` in all builds today, so the 19 MB is an install-time/`node_modules` cost, not a bundle cost). Net: a swap **shrinks `node_modules` ~16 MB** and ships a smaller, single-variant runtime — a genuine but not bundle-critical win given current externalization.

### Migration effort: **L (Large)**

Full rewrite of `worker.ts` open/read/write/export/close paths against the OO1 + capi API, plus `getSqliteVersion()` in `sqlite3.ts` (`sqlite3.version.libVersion`), plus new esbuild externalization/`.wasm`-copy plumbing, plus re-greening ~9 sqlite test files, plus re-validating the security defense-phasing against a different Emscripten module. ESM-only also interacts with the CJS build target (`build:lib:cjs`).

### Risk: **High**

- Security-sensitive surface: this is sandboxed-SQL-execution code with dedicated abuse tests (`sqlite3.worker-protocol-abuse.test.ts`, `python-sqlite-information-disclosure.test.ts`). Any deserialize/export pointer-lifecycle bug is a memory-safety/disclosure risk.
- Behavior parity across 11 output modes and error formatting must be byte-exact to satisfy the comparison/fixtures tests.
- ESM-only + capi pointer code is harder to bundle and harder to keep within the banned-pattern rules.

### Recommendation: **Don't swap (defer)**

The only concrete win is ~16 MB of `node_modules` and "official" provenance. Against that: a Large rewrite of security-critical, well-tested sandbox code, with High regression risk, for a runtime that is already externalized and working. `sql.js` is still maintained (1.14.1 published 2026-03-04) and fits the OO1-free, buffer-in/buffer-out model perfectly. **Revisit only if** (a) `sql.js` goes unmaintained, or (b) install-size becomes a hard requirement — and if so, do it as a dedicated, fully test-gated milestone, not a casual bump.

---

## 2. quickjs-emscripten → quickjs-ng

### Current usage (file:line)

Declared in `packages/bash/package.json`:
- `"quickjs-emscripten": "^0.32.0"` (line 151) — installed `0.32.0`.
- Externalized in esbuild: `--external:quickjs-emscripten` in `build:worker` (L87), `build:lib` (L88), `build:lib:cjs` (L89), `build:cli` (L92), `build:shell` (L93).

`packages/bash/src/commands/js-exec/worker.ts` (runs inside a worker; the only importer):
- L14–20: `import { getQuickJS, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten";`
- L78: `quickjsLoading = getQuickJS();` — module load, memoized (L71–81).
- L1090: `runtime = qjs.newRuntime();`
- L1091: `runtime.setMemoryLimit(MEMORY_LIMIT)` (64 MB).
- L1094–1097: `runtime.setInterruptHandler(...)` (cycle-count interrupt, `INTERRUPT_CYCLES = 100000`).
- L1099: `context = runtime.newContext();`
- L1100: `setupContext(context, backend, input)` — builds the entire guest global env using the handle API: `context.newFunction` (console.log/error/warn, `fs.*`, `__fetch`, `__exec`, `__execArgs`, `process.cwd/exit`), `context.newObject`, `context.newString/newNumber/newArray`, `context.setProp`, `context.dump`, `handle.dispose()`, `context.global`, `context.undefined/true/false`, `context.newError` (see `throwError` L124–129, `jsToHandle` L134–166, and L389–816).
- L1110, L1306, L1329–1330: `context.evalCode(...)` — defense-hardening prelude, optional bootstrap, and user code (script vs `{ type: "module" }`).
- L1362: `runtime.executePendingJobs()` — drains promise jobs / module bodies.
- L1333/1364: `context.dump(result.error)` + `.dispose()` for error extraction.
- L1412–1413: `context?.dispose(); runtime?.dispose();` cleanup.
- `js-exec.ts` L619 only emits the literal banner string `"QuickJS (quickjs-emscripten)\n"` for `-version` — no API call.

**API surface used:** the standard `quickjs-emscripten` synchronous host API — `getQuickJS`, `newRuntime`, `newContext`, `setMemoryLimit`, `setInterruptHandler`, `newContext`, `evalCode`, `executePendingJobs`, the full `QuickJSContext` handle/`newFunction`/`setProp`/`dump` set, and `dispose`. All of it is typed from `quickjs-emscripten-core`.

### Candidate

The quickjs-**ng** engine, consumed **through the same `quickjs-emscripten` family**: `@jitl/quickjs-ng-wasmfile-release-sync` (latest `0.32.0`, published 2026-02-16; unpacked 676 KB). quickjs-ng is the actively-maintained community fork of Bellard's QuickJS (newer ES support, ongoing security fixes).

> There is **no** `@quickjs-ng/quickjs-emscripten` package — `npm view` returns 404. The correct artifact is the `@jitl/quickjs-ng-*` *variant*, loaded via the library's variant mechanism.

### Compatibility assessment — KEY FINDING

**This is a variant swap inside one library, not a library replacement.** The `quickjs-emscripten` package is a thin meta-package whose default `getQuickJS()` resolves to the *original* QuickJS variant (`@jitl/quickjs-wasmfile-release-sync`), confirmed from its dependency set:

```
quickjs-emscripten@0.32.0 deps:
  @jitl/quickjs-wasmfile-debug-asyncify   0.32.0
  @jitl/quickjs-wasmfile-debug-sync       0.32.0
  @jitl/quickjs-wasmfile-release-asyncify 0.32.0
  @jitl/quickjs-wasmfile-release-sync     0.32.0   <- default getQuickJS()
  quickjs-emscripten-core                 0.32.0
```

The host-side classes (`QuickJSContext`, `QuickJSRuntime`, `QuickJSHandle`, `QuickJSWASMModule`) all live in `quickjs-emscripten-core` and are **shared across every variant**. The variant only swaps the underlying `.wasm` engine. The installed `quickjs-emscripten` already exposes the variant loaders (verified in its `dist/index`): `newQuickJSWASMModule`, `newQuickJSAsyncWASMModule`, `getQuickJS`, `getQuickJSSync`, `newVariant`, `RELEASE_SYNC`, `DEBUG_SYNC`.

**Migration mechanics (the entire code change):**
```ts
// before
import { getQuickJS } from "quickjs-emscripten";
quickjsLoading = getQuickJS();

// after
import { newQuickJSWASMModule } from "quickjs-emscripten-core";
import ngVariant from "@jitl/quickjs-ng-wasmfile-release-sync";
quickjsLoading = newQuickJSWASMModule(ngVariant);
```
Everything downstream of `getQuickJSModule()` — `newRuntime`, `setMemoryLimit`, `setInterruptHandler`, `newContext`, `evalCode`, `newFunction`, `setProp`, `dump`, `executePendingJobs`, `dispose` — is **byte-for-byte identical** because the types come from the same `quickjs-emscripten-core`. `setupContext` does not change at all.

**Breaking changes to watch (engine-level, not API-level):**
- quickjs-ng has *newer/more-complete* ES support, so guest programs may behave slightly differently (more spec features available). This must be re-validated against the large `js-exec.node-compat.test.ts` (49 KB) and the `js-exec.security.test.ts` / `module-resolution-security.test.ts` suites — particularly the in-guest hardening prelude (L1110+) that deletes `eval`/`Function` and freezes intrinsics, since intrinsic shape can differ between engines.
- Error message / stack-trace text may differ; `formatError` (L93–118) parses `at <eval> (...)` patterns — assert the output formatting still matches.
- The `-version` banner string `"QuickJS (quickjs-emscripten)"` (js-exec.ts L619) should be updated for honesty (e.g. `"QuickJS-ng"`).

**Worker-bridge / SharedStateBus integration impact:** **None.** The js-exec worker's SharedArrayBuffer protocol lives entirely in `SyncBackend` / `worker-bridge/protocol.ts` and is engine-agnostic — it marshals bytes, not JS values. The defense-in-depth exclusions (`shared_array_buffer`, `atomics`, `process_stdout`, `process_stderr`, worker.ts L1059–1071) are tied to the Node/worker host and Emscripten stdout routing, **not** to which QuickJS engine is inside the wasm, so they carry over unchanged. The init-before-defense ordering (`initializeWithDefense`, L1040) also carries over.

### WASM / package size delta

- Original variant `@jitl/quickjs-wasmfile-release-sync`: **649 KB** unpacked.
- ng variant `@jitl/quickjs-ng-wasmfile-release-sync`: **676 KB** unpacked.
- Delta ≈ **+27 KB** (negligible; both are `--external` from the JS bundle anyway). Size is a non-factor here — the motivation is engine maintenance/feature/security currency, not size.

### Migration effort: **S (Small)**

A ~3-line import/loader change in `getQuickJSModule()`, a dependency swap in `package.json` (replace `quickjs-emscripten` with `quickjs-emscripten-core` + the ng variant, update the 5 esbuild `--external` flags accordingly), a one-word `-version` banner update, and a re-green of the js-exec test suite. No `setupContext` change, no bridge change.

### Risk: **Low–Medium**

- **Low** structurally (shared host API, no integration/bridge churn).
- **Medium** behaviorally because js-exec runs untrusted guest JS and the in-guest hardening prelude assumes a specific intrinsic shape; a different engine could surface a hardening gap. This is fully covered by existing security tests, so the risk is "must re-run and read the diffs," not "unknown unknowns."

### Recommendation: **Swap later (opportunistic, test-gated)**

Worth doing — quickjs-ng is the actively-developed engine and the migration is a Small, mostly-mechanical variant change with zero bridge impact. But there is **no urgency** (current `quickjs-emscripten@0.32.0` works), and the change must clear the full js-exec security + node-compat suites because the engine swap can alter guest-observable behavior. **Bundle it with the next planned `quickjs-emscripten` version bump** rather than as a standalone change, and treat the security-test re-green as the acceptance gate.

---

## Summary table

| Dependency | Candidate | Effort | Risk | Bridge impact | Size delta | Recommendation |
|---|---|---|---|---|---|---|
| `sql.js` | `@sqlite.org/sqlite-wasm` | **L** | **High** | None (no SAB bridge in sqlite worker) | −16 MB node_modules | **Don't swap** (defer) |
| `quickjs-emscripten` | `@jitl/quickjs-ng-wasmfile-release-sync` (via `quickjs-emscripten-core`) | **S** | **Low–Med** | None | +27 KB | **Swap later** (opportunistic) |
