import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    // This standalone config does NOT inherit vitest.config.ts (--config
    // replaces it), so without these it falls back to Vitest 4's 5s/10s
    // defaults. This lane still collects files that test:integration (120s)
    // and test:e2e (600s) own, so a 5s per-test wall-clock deadline made the
    // suite load-dependent: identical code gave 9/11/13/14/18 failing files
    // across runs, and 33 of 89 failures were "Test timed out in 5000ms".
    // Match the repo-wide 120s (vitest.config.ts:10-11, vitest.wasm.config.ts:15-16).
    // Deliberately NOT `retry` — see the prohibition in vitest.wasm.config.ts:17-23.
    testTimeout: 120000,
    hookTimeout: 120000,
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // The Oils bash-parity corpus is owned by the ratchet
      // (scripts/check-spec-ratchet.js), not by this suite. It has 43 known
      // failures out of 3826 cases, so as an absolute-count gate it can never
      // be green and blocks every other gate from being made required. The
      // ratchet enforces the same corpus as a REGRESSION gate instead: it fails
      // on a new failure AND on a stale baseline entry. Coverage is relocated,
      // not dropped — `check:spec-ratchet` runs in quality.yml.
      "**/spec-tests/**",
      "**/security/attacks/**",
      "**/security/defense-in-depth-box*.test.ts",
      "**/browser.bundle.test.ts",
      "**/python-scripting.test.ts",
      "**/js-exec*.test.ts",
      // Owned by test:comparison (vitest.comparison.config.ts) — 32 files
      // double-collected here today.
      "src/comparison-tests/**",
      // Owned by test:wasm (vitest.wasm.config.ts include list): 120s timeout,
      // maxWorkers 1, retry 1, and a vendored CPython/SQLite WASM artifact.
      // Enumerated filenames were used here before, so files added later
      // (python3.stderr-finalization, python3.queue-desync.runtime) leaked in.
      // Enumerate exactly the sandbox files test:wasm includes — the other 4
      // under src/security/sandbox/ have no other owner, so a `sandbox/**`
      // glob would drop them from every gate.
      "src/commands/python3/**",
      "src/commands/sqlite3/**",
      "src/security/wasm-callback.test.ts",
      "src/security/worker-defense-in-depth.test.ts",
      "src/security/sandbox/python-sqlite-information-disclosure.test.ts",
      "src/security/sandbox/error-forwarding-runtime-leak-probe.test.ts",
      "src/security/sandbox/worker-protocol-runtime-desync.test.ts",
      // Owned by test:dist (needs the built dist/ artifact, 120s). Only these
      // two — NOT `**/*.bundle.test.ts`, because src/cli/shell.bundle.test.ts
      // is collected by no other lane.
      "src/cli/ag-bash.bundle.test.ts",
      "src/commands/tar/tar.bundle.test.ts",
    ],
    setupFiles: [resolve(__dirname, "packages/bash/src/vitest-setup.ts")],
    // Tests that patch globalThis (defense-in-depth) or spawn workers need
    // process-level isolation. In Vitest 4, use vitest.workspace.ts for this.
  },
});
