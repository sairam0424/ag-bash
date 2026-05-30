import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * MCP server test config.
 *
 * Resolves `@ag-bash/bash` to the workspace SOURCE (not the built dist bundle)
 * so tests exercise the current engine — mirroring the `paths` mapping in
 * tsconfig.json. Without this alias, vitest would resolve the stale
 * `dist/bundle/index.js`, which lags behind source between builds (e.g. it
 * would be missing newly-added public methods like `Bash.fork()`).
 */
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 120000,
    hookTimeout: 120000,
    isolate: false,
    setupFiles: [resolve(__dirname, "../bash/src/vitest-setup.ts")],
  },
  resolve: {
    alias: {
      "@ag-bash/bash": resolve(__dirname, "../bash/src/index.ts"),
    },
  },
});
