import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/security/attacks/**",
      "**/security/defense-in-depth-box*.test.ts",
      "**/security/wasm-callback.test.ts",
      "**/security/worker-defense-in-depth.test.ts",
      "**/security/sandbox/python-sqlite-information-disclosure.test.ts",
      "**/security/sandbox/error-forwarding-runtime-leak-probe.test.ts",
      "**/security/sandbox/worker-protocol-runtime-desync.test.ts",
      "**/browser.bundle.test.ts",
      "**/python-scripting.test.ts",
      // Directory-level excludes (not individual filenames): vitest.wasm.config.ts
      // claims every *.test.ts under these three command directories via its own
      // broad glob (src/commands/{python3,sqlite3,js-exec}/**/*.test.ts). Naming
      // files here one-by-one previously drifted out of sync as new test files
      // were added - fs-bridge-handler.output-limit.test.ts, python3.queue-desync
      // .runtime.test.ts, python3.queue-timeout-exploit.test.ts, python3.stderr
      // -finalization.test.ts, and python3.worker-protocol-abuse.test.ts, plus 8
      // of 9 sqlite3.*.test.ts files, were all silently double-collected by both
      // configs until this audit (found while diagnosing an unrelated Vitest 5
      // migration false alarm). Matching wasm.config's own directory-level intent
      // here closes the gap for good instead of re-drifting the next time a file
      // is added.
      "**/commands/python3/**",
      "**/commands/sqlite3/**",
      "**/commands/js-exec/**",
    ],
    setupFiles: [resolve(__dirname, "packages/bash/src/vitest-setup.ts")],
    // Tests that patch globalThis (defense-in-depth) or spawn workers need
    // process-level isolation. Use vitest.workspace.ts for this (verified
    // still functional under Vitest 5.0.2, not just a Vitest-4-era mechanism).
  },
});
