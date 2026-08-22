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
    setupFiles: [resolve(__dirname, "packages/bash/src/vitest-setup.ts")],
    // Tests that patch globalThis (defense-in-depth) or spawn workers need
    // process-level isolation. In Vitest 4, use vitest.workspace.ts for this.
  },
});
