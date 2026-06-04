#!/usr/bin/env node
/**
 * Perf-regression gate.
 *
 * Compares a freshly produced `vitest bench --outputJson` report against a
 * committed baseline and exits non-zero if ANY benchmark's mean time has
 * regressed by more than the threshold (default 15%).
 *
 * Usage:
 *   node scripts/bench-check.js [--current <file>]... [--baseline <file>]
 *                               [--threshold <fraction>] [--update]
 *
 * Defaults:
 *   --current   bench-results.json          (CI-produced report; repeatable)
 *   --baseline  bench-baseline.json         (committed baseline)
 *   --threshold 0.15                         (15% slower = fail)
 *   --update    rewrite the baseline from the current report(s) and exit 0
 *
 * The report shape (vitest 4 `--outputJson`):
 *   { files: [ { groups: [ { fullName, benchmarks: [ { name, mean, hz, rme } ] } ] } ] }
 *
 * Benchmarks are keyed by "<group.fullName> :: <benchmark.name>". A benchmark
 * present in the baseline but missing from the current report is reported as
 * an error (the bench was removed/renamed — the gate should be updated
 * deliberately, not silently). New benchmarks not in the baseline are noted
 * but never fail the gate.
 *
 * Comparison metric: mean time (ms), BEST (minimum) across all --current
 * reports. Lower is better, so a regression is
 *   (best.mean - baseline.mean) / baseline.mean > threshold.
 *
 * Best-of-N rationale: vitest's `mean` is tail-sensitive, and on a shared CI
 * runner (ubuntu-latest) transient CPU contention / GC pauses inflate the mean
 * of a SINGLE run by 30%+ run-to-run for the macro Bash.exec benches — pure
 * environmental noise, not a code change (verified: the *minimum* mean across
 * runs tracks the committed baseline within ±3%). Comparing the minimum mean
 * across a few repeated runs uses each benchmark's noise-floor — the value that
 * reflects true code speed — so the gate stops flaking on noise while still
 * catching real regressions (a genuine slowdown raises the floor in EVERY run,
 * so the minimum rises too and the gate still trips). Pass several --current
 * reports (one per repeated `bench:ci`) to enable this; a single report still
 * works (best-of-1 == that run).
 *
 * Pure Node, no deps, ESM (package is "type": "module").
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const DEFAULTS = Object.freeze({
  current: resolve(PKG_ROOT, "bench-results.json"),
  baseline: resolve(PKG_ROOT, "bench-baseline.json"),
  // 15% slower mean = regression (per the C2 perf-gate spec). Env-overridable.
  threshold: envNumber("BENCH_THRESHOLD", 0.15),
  // Absolute-delta floor: a benchmark only FAILS when it exceeds BOTH the
  // percentage threshold AND this many ms of additional mean time. Sub-ms
  // micro-benches (parser/cache) have large relative jitter on noisy CI
  // hosts; without a floor, pure noise trips the percentage gate. Macro
  // benches (cold Bash.exec ~10ms) clear this floor trivially, so the 15%
  // gate fully applies to them.
  minAbsMs: envNumber("BENCH_MIN_ABS_MS", 0.05),
});

function parseArgs(argv) {
  const out = {
    // `--current` is repeatable: each occurrence appends a report path. Left
    // empty here so an explicit flag REPLACES the default rather than adding
    // to it; we fall back to [DEFAULTS.current] after parsing if none given.
    currents: [],
    baseline: DEFAULTS.baseline,
    threshold: DEFAULTS.threshold,
    minAbsMs: DEFAULTS.minAbsMs,
    update: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--update") {
      out.update = true;
    } else if (arg === "--current") {
      out.currents.push(resolve(argv[++i]));
    } else if (arg === "--baseline") {
      out.baseline = resolve(argv[++i]);
    } else if (arg === "--threshold") {
      const v = Number.parseFloat(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error(
          `--threshold must be a positive number, got "${argv[i]}"`,
        );
      }
      out.threshold = v;
    } else if (arg === "--min-abs-ms") {
      const v = Number.parseFloat(argv[++i]);
      if (!Number.isFinite(v) || v < 0) {
        throw new Error(
          `--min-abs-ms must be a non-negative number, got "${argv[i]}"`,
        );
      }
      out.minAbsMs = v;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (out.currents.length === 0) out.currents.push(DEFAULTS.current);
  return out;
}

/**
 * Reduce several flattened reports to one map of the BEST (minimum) mean per
 * benchmark, keyed by name. The minimum is each benchmark's noise-floor across
 * the repeated runs — the value least corrupted by transient CI contention and
 * the closest proxy for true code speed. `hz` is recomputed from the chosen
 * (minimum-mean) sample so the reported pair stays internally consistent.
 */
function bestOf(flatMaps) {
  const out = Object.create(null);
  for (const flat of flatMaps) {
    for (const key of Object.keys(flat)) {
      const candidate = flat[key];
      const existing = out[key];
      if (!existing || candidate.mean < existing.mean) {
        out[key] = candidate;
      }
    }
  }
  return out;
}

function describeError(err) {
  // Dev-only CLI tooling: surface the OS error code when present (ENOENT
  // etc.), otherwise the stringified error. No untrusted-script surface here.
  if (err && typeof err === "object" && "code" in err && err.code) {
    return String(err.code);
  }
  return String(err);
}

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read "${path}": ${describeError(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in "${path}": ${describeError(err)}`);
  }
}

/**
 * Flatten a vitest bench report into a null-prototype map of
 * "<group> :: <bench>" -> { mean, hz }.
 */
function flatten(report) {
  const map = Object.create(null);
  const files = Array.isArray(report?.files) ? report.files : [];
  for (const file of files) {
    const groups = Array.isArray(file?.groups) ? file.groups : [];
    for (const group of groups) {
      const groupName = group?.fullName ?? "(unnamed group)";
      const benches = Array.isArray(group?.benchmarks) ? group.benchmarks : [];
      for (const b of benches) {
        if (typeof b?.name !== "string" || typeof b?.mean !== "number") {
          continue;
        }
        const key = `${groupName} :: ${b.name}`;
        map[key] = { mean: b.mean, hz: typeof b.hz === "number" ? b.hz : 0 };
      }
    }
  }
  return map;
}

function fmtMs(ms) {
  return `${ms.toFixed(4)}ms`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Best (minimum mean) per benchmark across every --current report.
  const currentFlats = opts.currents.map((p) => flatten(readJson(p)));
  const current = bestOf(currentFlats);

  if (opts.update) {
    const keys = Object.keys(current);
    if (keys.length === 0) {
      console.error(
        `[bench-check] refusing to write empty baseline from ${opts.currents
          .map((p) => `"${p}"`)
          .join(", ")}.`,
      );
      process.exit(1);
    }
    // Persist only the stable fields (mean/hz) keyed by name — not the noisy
    // raw sample arrays — so baseline diffs stay readable. With multiple
    // --current reports this writes the best-of-N value per benchmark.
    const baseline = {
      generatedAt: new Date().toISOString(),
      benchmarks: current,
    };
    writeFileSync(opts.baseline, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(
      `[bench-check] wrote baseline with ${keys.length} benchmark(s) to ${opts.baseline} ` +
        `(best of ${opts.currents.length} run(s))`,
    );
    process.exit(0);
  }

  const baselineRaw = readJson(opts.baseline);
  // Baseline may be either a raw vitest report or our trimmed { benchmarks }.
  const baseline =
    baselineRaw &&
    typeof baselineRaw.benchmarks === "object" &&
    baselineRaw.benchmarks
      ? baselineRaw.benchmarks
      : flatten(baselineRaw);

  const pct = (opts.threshold * 100).toFixed(0);
  console.log(
    `[bench-check] gate: +${pct}% slower mean AND +${opts.minAbsMs}ms absolute = FAIL`,
  );
  console.log(
    `[bench-check] metric:    best (min) mean of ${opts.currents.length} run(s)`,
  );
  console.log(`[bench-check] baseline:  ${opts.baseline}`);
  console.log(`[bench-check] current:   ${opts.currents.join(", ")}\n`);

  const regressions = [];
  const missing = [];
  const added = [];
  const ok = [];

  for (const key of Object.keys(baseline)) {
    const base = baseline[key];
    const cur = current[key];
    if (!cur) {
      missing.push(key);
      continue;
    }
    const absMs = cur.mean - base.mean;
    const delta = absMs / base.mean;
    const row = {
      key,
      baseMean: base.mean,
      curMean: cur.mean,
      delta,
      absMs,
    };
    // Require BOTH the percentage threshold and the absolute floor so noisy
    // sub-ms micro-benches don't fail on jitter, while real macro regressions
    // (which easily clear the floor) are still caught at 15%.
    if (delta > opts.threshold && absMs > opts.minAbsMs) {
      regressions.push(row);
    } else {
      ok.push(row);
    }
  }

  for (const key of Object.keys(current)) {
    if (!(key in baseline)) added.push(key);
  }

  for (const row of ok) {
    const sign = row.delta >= 0 ? "+" : "";
    console.log(
      `  OK    ${row.key}\n          ${fmtMs(row.baseMean)} -> ${fmtMs(row.curMean)} (${sign}${(row.delta * 100).toFixed(1)}%)`,
    );
  }
  for (const key of added) {
    console.log(`  NEW   ${key} (not in baseline — not gated)`);
  }
  for (const key of missing) {
    console.log(`  GONE  ${key} (in baseline, absent from current report)`);
  }
  for (const row of regressions) {
    console.log(
      `  FAIL  ${row.key}\n          ${fmtMs(row.baseMean)} -> ${fmtMs(row.curMean)} (+${(row.delta * 100).toFixed(1)}% > +${pct}%)`,
    );
  }

  console.log("");

  // A removed/renamed benchmark fails the gate so the baseline is updated
  // deliberately (run with --update) rather than silently drifting.
  if (missing.length > 0) {
    console.error(
      `[bench-check] FAIL: ${missing.length} baseline benchmark(s) missing from current report. ` +
        `If this is intentional, regenerate the baseline with: pnpm bench:ci && node scripts/bench-check.js --update`,
    );
    process.exit(1);
  }

  if (regressions.length > 0) {
    console.error(
      `[bench-check] FAIL: ${regressions.length} benchmark(s) regressed more than +${pct}%.`,
    );
    process.exit(1);
  }

  console.log(
    `[bench-check] PASS: ${ok.length} benchmark(s) within +${pct}% of baseline.`,
  );
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error(`[bench-check] failed -> ${describeError(err)}`);
  process.exit(2);
}
