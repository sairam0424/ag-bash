import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves `@ag-bash/bash` to the workspace SOURCE (not the built dist
 * bundle) so tests exercise the current engine — mirrors
 * packages/mcp-server/vitest.config.ts's rationale for the same alias.
 */
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      "@ag-bash/bash": resolve(__dirname, "../bash/src/index.ts"),
    },
  },
});
