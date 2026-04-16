import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    include: [
      "**/security/attacks/**",
      "**/security/defense-in-depth-box*.test.ts",
      "**/browser.bundle.test.ts",
      "**/python3.test.ts",
      "**/python3.advanced.test.ts",
      "**/python3.env.test.ts",
      "**/python3.files.test.ts",
      "**/python3.http.test.ts",
      "**/python3.oop.test.ts",
      "**/python3.optin.test.ts",
      "**/python3.security.test.ts",
      "**/python3.stdlib.test.ts",
      "**/python-scripting.test.ts",
      "**/sqlite3.worker-protocol-abuse.test.ts",
      "**/js-exec*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    pool: "forks",
    // Mock tests (worker-protocol-abuse, queue-timeout-exploit) use
    // vi.mock to replace node:worker_threads. They share module-level queue
    // state with real tests, so each file needs its own module instance.
    isolate: true,
    setupFiles: [resolve(__dirname, "src/vitest-setup.ts")],
    // WASM worker tests need process-level isolation.
    // In Vitest 4, use vitest.workspace.ts for this.
  },
});
