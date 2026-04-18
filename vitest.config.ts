import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 120000,
    hookTimeout: 120000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/examples/**",
      "**/.pnpm-store/**",
    ],
    isolate: false,
    setupFiles: [resolve(__dirname, "packages/bash/src/vitest-setup.ts")],
    // Tests that spawn workers (sqlite3, python) need process-level isolation
    // because defense-in-depth patches globalThis which is shared across threads.
    // In Vitest 4, this is handled via workspaces in vitest.workspace.ts.
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.comparison.test.ts",
        "src/spec-tests/**",
        "src/comparison-tests/**",
        "src/cli/**",
        "src/agent-examples/**",
      ],
    },
  },
});
