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
import { type BenchOptions, bench, describe } from "vitest";
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
const COLD_OPTS: BenchOptions = {
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
const WARM_OPTS: BenchOptions = {
  time: 1000,
  warmupTime: 200,
  warmupIterations: 100,
};

describe("Bash.exec (pipeline)", () => {
  bench(
    "cold — new instance + small pipeline",
    async () => {
      const bash = new Bash({ cwd: "/app", files: FILES });
      await bash.exec(SCRIPT, { execMode: "pipeline" });
    },
    COLD_OPTS,
  );

  bench(
    "warm — reused instance, ASTCache hot",
    async () => {
      await warmBash.exec(SCRIPT, { execMode: "pipeline" });
    },
    WARM_OPTS,
  );

  bench(
    "warm — simple echo",
    async () => {
      await warmBash.exec("echo hello world", { execMode: "pipeline" });
    },
    WARM_OPTS,
  );
});
