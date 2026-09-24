import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    include: ["src/comparison-tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: [
      resolve(__dirname, "packages/bash/src/comparison-tests/vitest.setup.ts"),
    ],
  },
});
