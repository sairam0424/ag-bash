import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    include: [
      "src/security/attacks/**/*.test.ts",
      "src/security/defense-in-depth-box*.test.ts",
      "src/security/worker-defense-in-depth.test.ts",
      "src/security/wasm-callback.test.ts",
      "src/security/sandbox/python-sqlite-information-disclosure.test.ts",
      "src/security/sandbox/error-forwarding-runtime-leak-probe.test.ts",
      "src/security/sandbox/worker-protocol-runtime-desync.test.ts",
      "src/browser.bundle.test.ts",
      "src/python3.test.ts",
      "src/python3.advanced.test.ts",
      "src/python3.env.test.ts",
      "src/python3.files.test.ts",
      "src/python3.http.test.ts",
      "src/python3.oop.test.ts",
      "src/python3.optin.test.ts",
      "src/python3.security.test.ts",
      "src/python3.stdlib.test.ts",
      "src/python-scripting.test.ts",
      "src/sqlite3.worker-protocol-abuse.test.ts",
      "src/js-exec*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    pool: "forks",
    // Mock tests (worker-protocol-abuse, queue-timeout-exploit) use
    // vi.mock to replace node:worker_threads. They share module-level queue
    // state with real tests, so each file needs its own module instance.
    isolate: true,
    setupFiles: [resolve(__dirname, "packages/bash/src/vitest-setup.ts")],
    // WASM worker tests need process-level isolation.
    // In Vitest 4, use vitest.workspace.ts for this.
  },
});
