import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Dedicated config for performance benchmarks (`*.bench.ts`).
 *
 * Benchmarks are intentionally separated from the test suites:
 *  - `test:run` uses the default test glob (`*.{test,spec}.ts`) and never
 *    picks up `*.bench.ts`.
 *  - benches run only via `pnpm bench` / `vitest bench` against this config.
 *
 * Single fork, no isolation, so timings are stable on a quiet CI runner.
 * CI should run `pnpm bench:check` on a dedicated/stable runner — shared
 * CI hosts have noisy CPU neighbors that inflate variance.
 */
export default defineConfig({
  test: {
    globals: true,
    setupFiles: [resolve(__dirname, "src/vitest-setup.ts")],
    benchmark: {
      include: ["src/**/*.bench.ts"],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        // python/sqlite/js-exec benches would spawn workers; none exist yet
        // and we deliberately avoid them to keep `bench` worker-free.
        "src/commands/python3/**",
        "src/commands/sqlite3/**",
        "src/commands/js-exec/**",
        "src/commands/ag-convert/**",
      ],
    },
    // Single fork keeps benchmark timings comparable run-to-run.
    // Vitest 4 moved pool tuning to top-level options.
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    isolate: false,
  },
});
