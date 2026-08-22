import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    // `include` is resolved against the CWD, and test:comparison runs from
    // packages/bash -- not from this config's directory. A repo-root-relative
    // glob here resolved to packages/bash/packages/bash/src/... and matched
    // nothing, so the suite reported "No test files found" and exited 1,
    // making the comparison gate and every step chained after it unreachable.
    // Mirrors the CWD-relative include + __dirname-anchored setupFiles that
    // vitest.unit.config.ts already uses.
    include: ["src/comparison-tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: [
      resolve(__dirname, "packages/bash/src/comparison-tests/vitest.setup.ts"),
    ],
  },
});
