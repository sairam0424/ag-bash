# Performance Benchmarks & Regression Gate

Ag-Bash ships micro/macro benchmarks for the hot paths and a CI gate that
fails the build when any benchmark regresses more than **15%** versus a
committed baseline.

Benchmarks are completely separate from the test suite. `pnpm test:run`
uses vitest's default test glob (`*.{test,spec}.ts`) and never collects
`*.bench.ts` files — they execute only under `vitest bench`.

## What is benchmarked

All bench files live next to the code they measure under
`packages/bash/src/`:

| File | Hot path |
| --- | --- |
| `src/parser/parser.bench.ts` | Legacy recursive-descent `parse()` over a representative script and a one-liner. |
| `src/parser/ASTCache.bench.ts` | `ASTCache` get-hit vs get-miss, miss+reparse (the realized cold-key cost), and `set` + LRU eviction. |
| `src/Bash.exec.bench.ts` | End-to-end `Bash.exec` in **pipeline** mode (the v6.0.0 default): cold (fresh instance) vs warm (reused, ASTCache hot). |

> Python / sqlite / js-exec are intentionally **not** benchmarked: they spawn
> WASM worker threads, which can hang under the bench runner. The bench config
> explicitly excludes those command directories so `pnpm bench` stays
> worker-free.

## Running

All commands run from `packages/bash/`:

```bash
# Run every benchmark and print a human-readable table.
pnpm bench

# Run a single bench file.
pnpm exec vitest bench --run --config vitest.bench.config.ts src/parser/parser.bench.ts

# Produce the machine-readable report CI consumes (bench-results.json).
pnpm bench:ci

# Run the benches AND compare against the committed baseline.
# Exits non-zero if any benchmark is >15% slower than baseline.
pnpm bench:check

# Re-record the baseline from a fresh run (do this deliberately, e.g. after an
# intentional perf change, and commit bench-baseline.json).
pnpm bench:update
```

## The regression gate

`scripts/bench-check.js` is pure Node (no deps). It:

1. Reads the fresh report (`bench-results.json`, a CI artifact — git-ignored).
2. Reads the committed baseline (`bench-baseline.json` — **committed**).
3. For each baseline benchmark, computes the percentage delta
   `(current.mean - baseline.mean) / baseline.mean` and the absolute delta
   `current.mean - baseline.mean` (ms).
4. **Fails** (exit 1) only when a benchmark regresses past **both** the
   percentage threshold (default `0.15`) **and** an absolute-delta floor
   (default `0.05ms`). The dual condition is deliberate: sub-millisecond
   micro-benches (parser/cache) have large relative jitter on noisy hosts, so
   a percentage-only gate would fail on pure noise. The floor lets jitter
   through while still catching real regressions — a genuine +50% on the
   ~0.135ms representative-parse bench adds ~0.068ms, clearing the floor and
   failing the gate. Macro benches (cold `Bash.exec` ~10ms) clear the floor
   trivially, so the 15% gate fully applies to them.
5. **Fails** if a baseline benchmark is missing from the current report — a
   removed/renamed bench must be acknowledged via `pnpm bench:update`, not
   silently dropped. New benches not in the baseline are noted but never fail.

Benchmarks are keyed by `"<group fullName> :: <bench name>"`. The compared
metric is **mean time (ms); lower is better**.

Flags / env:

```bash
node scripts/bench-check.js \
  --current   bench-results.json \   # fresh report
  --baseline  bench-baseline.json \  # committed baseline
  --threshold 0.15 \                 # 15% slower = candidate regression
  --min-abs-ms 0.05 \                # AND +0.05ms absolute = fail
  --update                           # rewrite baseline from current, then exit 0

# Env overrides (handy for tuning a noisy runner without editing scripts):
#   BENCH_THRESHOLD=0.20  BENCH_MIN_ABS_MS=0.1  pnpm bench:check
```

## CI wiring

Run `pnpm bench:check` as a **separate job from `test:run`**, on a
**dedicated / stable runner**. Benchmark timings are sensitive to noisy CPU
neighbors on shared CI hosts, which inflates variance and produces false
regressions. The bench config pins a single fork
(`maxWorkers: 1`, `fileParallelism: false`, `isolate: false`) for run-to-run
comparability, but the runner still needs to be quiet.

If a legitimate, intentional perf change trips the gate, re-record and commit
the baseline:

```bash
pnpm bench:update
git add packages/bash/bench-baseline.json
```

## Files

- `packages/bash/vitest.bench.config.ts` — bench-only vitest config.
- `packages/bash/scripts/bench-check.js` — the regression gate.
- `packages/bash/bench-baseline.json` — committed baseline (mean/hz per bench).
- `packages/bash/bench-results.json` — CI artifact (git-ignored).
- `packages/bash/src/**/*.bench.ts` — the benchmarks.
