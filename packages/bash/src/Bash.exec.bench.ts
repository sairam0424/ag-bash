/**
 * End-to-end performance benchmark for Bash.exec in pipeline mode
 * (the default v6.0.0 execution engine).
 *
 * Each iteration constructs a fresh Bash instance (cold path: no cache
 * warmth, no persisted state) and runs a small in-memory pipeline so
 * the number reflects construct + normalize + parse + interpret +
 * teardown — the realistic per-call cost agents pay.
 *
 * A second bench reuses a single instance to isolate the steady-state
 * exec cost once the ASTCache and services are warm.
 *
 * No WASM runtimes (python/js-exec) are touched, so there is no worker
 * thread and no hang risk under `vitest bench`.
 *
 * Run: pnpm exec vitest bench --run src/Bash.exec.bench.ts
 */
// `BenchCompareOptions` is vitest's re-export of tinybench's OWN `BenchOptions`
// (time/iterations/warmupTime/warmupIterations) - vitest's own same-named
// `BenchOptions` type is a different, narrower alias for tinybench's
// `FnOptions` (per-function hooks only), so the sampling-window fields below
// must use this re-export, not the naturally-reached-for `BenchOptions` name.
import { type BenchCompareOptions, describe, it } from "vitest";
import { Bash } from "./Bash.js";

const SCRIPT = "cat /app/data.txt | grep foo | wc -l";
const FILES = { "/app/data.txt": "hello world\nfoo bar\nfoo baz\nqux\n" };

// Shared warm instance for the steady-state bench.
const warmBash = new Bash({ cwd: "/app", files: FILES });

/**
 * Sampling options for the COLD bench. Each iteration constructs a fresh Bash
 * and tears it down, so a single iteration costs ~10-14ms. With tinybench's
 * defaults (500ms window, 5 warmup iterations) that yields only ~36-45 samples
 * and a high ±7-11% rme — the cold-start, JIT-warming, and first-touch
 * module/GC effects dominate and the per-run *minimum* mean (the value the
 * best-of-N perf gate keys off) never settles. On a quiet machine that minimum
 * tracks the baseline; on a shared CI runner (ubuntu-latest) transient CPU
 * contention inflates even the minimum, flaking the gate on pure noise.
 *
 * Widening the warmup + measurement window gives the cold path enough samples
 * for its noise-floor (minimum mean) to converge, so best-of-N reflects true
 * code speed instead of setup jitter. This changes ONLY how the harness samples
 * Bash.exec — never what it executes.
 */
const COLD_OPTS: BenchCompareOptions = {
  // Longer window + a higher iteration floor => the minimum mean settles.
  time: 2000,
  iterations: 50,
  // Pay the one-time JIT / module-graph / GC costs before measuring.
  warmupTime: 500,
  warmupIterations: 20,
};

/**
 * Sampling options for the WARM (steady-state) benches. These already get
 * thousands of samples at ±1.5% rme with the defaults; we set an explicit,
 * slightly longer window so run-to-run sample counts stay consistent and the
 * minimum mean is rock-stable for the gate. Sub-ms per iteration, so the cost
 * of the extra window is negligible.
 */
const WARM_OPTS: BenchCompareOptions = {
  time: 1000,
  warmupTime: 200,
  warmupIterations: 100,
};

// Vitest 5 moved `bench` from a top-level describe-block function to a
// TestContext fixture: each benchmark is its own `it(...)` receiving
// `{ bench }`, which is itself the registration factory (`bench(name, fn)`).
// The sampling-window options (time/iterations/warmup*) that the old
// `bench(name, fn, options)` form took as its 3rd argument now go to
// `.run(options)` instead — the factory's own optional middle argument is a
// DIFFERENT, narrower options type (per-function hooks only, see the
// BenchCompareOptions import comment above). Keeping one `it` per former
// `bench` call preserves the same benchmark names for the historical
// bench-results.json entries.
describe("Bash.exec (pipeline)", () => {
  it("cold — new instance + small pipeline", async ({ bench }) => {
    await bench("cold — new instance + small pipeline", async () => {
      const bash = new Bash({ cwd: "/app", files: FILES });
      await bash.exec(SCRIPT, { execMode: "pipeline" });
    }).run(COLD_OPTS);
  });

  it("warm — reused instance, ASTCache hot", async ({ bench }) => {
    await bench("warm — reused instance, ASTCache hot", async () => {
      await warmBash.exec(SCRIPT, { execMode: "pipeline" });
    }).run(WARM_OPTS);
  });

  it("warm — simple echo", async ({ bench }) => {
    await bench("warm — simple echo", async () => {
      await warmBash.exec("echo hello world", { execMode: "pipeline" });
    }).run(WARM_OPTS);
  });
});
