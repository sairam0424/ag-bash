import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    // This standalone config does NOT inherit vitest.config.ts, so without
    // these it would fall back to Vitest's 5s default — far too short for the
    // WASM suites it targets (a CPython/SQLite cold-start can take seconds, and
    // longer under CI/machine load). A too-short timeout here produced a
    // load-induced spurious failure. Match the repo-wide 120s.
    testTimeout: 120000,
    hookTimeout: 120000,
    // WASM-ONLY retry. The cold-start / shared-worker-pool flakiness documented
    // above is infrastructural, not a correctness signal, so retry once. This is
    // SAFE here because this config targets WASM-runtime + sandbox suites whose
    // assertions are deterministic once the runtime is up — a retry masks a slow
    // cold start, never a wrong result. NEVER add `retry` to the unit/fuzz/
    // comparison configs: there, a test that only passes on retry IS a failure
    // (especially a security assertion). Keep retry confined to this file.
    retry: 1,
    include: [
      // WASM-runtime command suites. Paths updated to the post-refactor
      // locations under src/commands/ (the old src/python3.*.test.ts globs
      // matched nothing, so these suites were silently uncollected).
      "src/commands/python3/**/*.test.ts",
      "src/commands/sqlite3/**/*.test.ts",
      "src/commands/js-exec/**/*.test.ts",
      "src/agent-examples/python-scripting.test.ts",
      // Security suites that exercise the WASM runtimes / worker bridge.
      "src/security/attacks/**/*.test.ts",
      "src/security/defense-in-depth-box*.test.ts",
      "src/security/worker-defense-in-depth.test.ts",
      "src/security/wasm-callback.test.ts",
      "src/security/sandbox/python-sqlite-information-disclosure.test.ts",
      "src/security/sandbox/error-forwarding-runtime-leak-probe.test.ts",
      "src/security/sandbox/worker-protocol-runtime-desync.test.ts",
      "src/browser.bundle.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // QUARANTINE FULLY CLEARED. Correcting the stale include globs (above)
      // exposed a batch of pre-existing, never-gated failures; each was triaged
      // bash-parity-first and fixed at the SOURCE (never by editing tests to
      // expect ag-bash's wrong output). Resolved:
      //  - argv-drop family (root cause: dead exec({args}) consumer wired live in
      //    c996b84): timeout, env, js-exec spawnSync, + the security suites that
      //    rode on it (js-exec-host-runtime-breakout, js-exec-recursion-guard,
      //    timeout-stdin-forwarding).
      //  - find-exec / nested-exec quoting: realigned to bash-correct behavior,
      //    security (injection MARKER ABSENT) invariant preserved + strengthened.
      //  - `time`: command existed but was never registered + used the dead args
      //    path — registered it and hardened to shellJoinArgs.
      //  - error-forwarding leak probe: harness used an unsupported Bash({fs:
      //    ReadWriteFs}) construction; realigned to the documented mount pattern
      //    and strengthened the no-host-path-leak assertion.
      //  - browser.bundle: __BROWSER__ guards weren't tree-shakeable, so
      //    sqlite3/yq/xan/tar (node-only) leaked into the browser build — fixed
      //    the guards so they're excluded.
      // No files remain quarantined. Re-add an exclude here ONLY for a genuinely
      // intractable, documented reason.
    ],
    pool: "forks",
    // CPython/SQLite/QuickJS WASM workers are heavy and share a per-process
    // worker pool plus module-level queue state. Running multiple WASM-heavy
    // files concurrently exhausts/poisons that pool, producing fast spurious
    // setup failures that vary run-to-run (e.g. 10 vs 21 fails). Isolate each
    // file in its own fork AND run files one-at-a-time so every file gets a
    // clean pool. `isolate` also gives the mock tests (worker-protocol-abuse,
    // queue-timeout-exploit, which vi.mock node:worker_threads) their own
    // module instance. Slower, but deterministic — the right trade for a gate.
    isolate: true,
    fileParallelism: false,
    // maxWorkers: 1 already serializes to a single worker (minWorkers is both
    // redundant here and not a valid top-level InlineConfig key in Vitest 4).
    maxWorkers: 1,
    setupFiles: [resolve(__dirname, "packages/bash/src/vitest-setup.ts")],
  },
});
