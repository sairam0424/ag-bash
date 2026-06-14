#!/usr/bin/env node
/**
 * Differential fuzzing harness for ag-bash.
 *
 * Generates random-but-valid-ish, side-effect-free bash snippets from a small
 * safe grammar, runs each one through BOTH the host's real `bash` AND the
 * built ag-bash CLI, then reports any divergence (stdout / exitCode mismatch)
 * as a candidate compatibility bug.
 *
 * The grammar is intentionally restricted to pure-stdout constructs:
 *   echo (with quoting), printf, arithmetic $((...)), pipes (echo|wc|grep|...),
 *   for/while loops, variable assignment + expansion, test/[ ] conditionals,
 *   and simple string ops (${#var}, ${var:offset:len}, ${var^^}, ...).
 * It NEVER emits destructive ops (no rm/mv/redirection to real files), no
 * network, and no host mutation — every snippet is read-only and self-contained.
 *
 * Determinism: a tiny seeded xorshift32 PRNG drives all generation (the global
 * Math RNG is intentionally NOT used — it is both nondeterministic and a banned
 * pattern in this repo). Re-running with the same --seed reproduces the exact
 * same snippet sequence, so any divergence is reproducible bit-for-bit.
 *
 * Usage:
 *   node scripts/differential-fuzz.js [--iterations N] [--seed S]
 *                                     [--timeout MS] [--out FILE]
 *                                     [--bash PATH] [--bin PATH]
 *                                     [--fail-on-divergence] [--verbose]
 *
 * Defaults:
 *   --iterations 200      number of snippets to generate + compare
 *   --seed 1              xorshift32 seed (any positive integer)
 *   --timeout 5000        per-snippet wall-clock timeout in ms (each engine)
 *   --out fuzz-divergences.json   where divergences are written
 *   --bash $(which bash)  host bash binary
 *   --bin dist/bin/ag-bash.js     built ag-bash CLI entrypoint
 *   --fail-on-divergence  exit non-zero if any divergence is found (CI mode;
 *                         OFF by default — finding compat bugs is the goal,
 *                         not a failure, so a plain run always exits 0)
 *   --verbose             print each divergence to stderr as it is found
 *
 * Exit codes:
 *   0  ran to completion (divergences may have been found and written)
 *   1  ran to completion WITH divergences AND --fail-on-divergence was set
 *   2  harness/setup error (missing bash, missing built bin, bad args)
 *
 * Pure Node, no new deps, ESM ("type": "module").
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Seeded PRNG (xorshift32). Deterministic, seed-driven, not the banned global
// Math RNG. State is threaded explicitly so generation is reproducible.
// ---------------------------------------------------------------------------

/**
 * Create a seeded xorshift32 generator.
 * @param {number} seed positive 32-bit integer seed
 * @returns {{ next: () => number, int: (n: number) => number, pick: <T>(arr: readonly T[]) => T }}
 */
function createPrng(seed) {
  // xorshift32 needs a non-zero state; fold the seed into a safe range.
  let state = seed >>> 0 || 0x9e3779b9;
  const nextUint = () => {
    state ^= (state << 13) >>> 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    return state;
  };
  // Float in [0, 1).
  const next = () => nextUint() / 0x100000000;
  // Integer in [0, n).
  const int = (n) => (n <= 0 ? 0 : nextUint() % n);
  // Pick a uniform element from a non-empty array.
  const pick = (arr) => arr[int(arr.length)];
  return Object.freeze({ next, int, pick });
}

// ---------------------------------------------------------------------------
// Grammar. Each generator returns { code, note } where `note` optionally flags
// the snippet as a known-divergent / unsupported construct so we can annotate
// rather than spam false positives.
// ---------------------------------------------------------------------------

const SAFE_WORDS = Object.freeze([
  "alpha",
  "beta",
  "gamma",
  "x",
  "y",
  "z",
  "foo",
  "bar",
  "baz",
  "12",
  "007",
  "hello world",
  "a b c",
  "tab\tsep",
  "with-dash",
  "under_score",
  "MiXeD",
]);

const VAR_NAMES = Object.freeze(["A", "B", "C", "V", "N", "S", "I"]);

const SMALL_INTS = Object.freeze([0, 1, 2, 3, 5, 7, 10, 13, 21, 100]);

// Quote a literal word for the generated snippet, exercising single, double,
// and unquoted forms. Words that contain whitespace/tabs always get quoted so
// the grammar stays "valid-ish" rather than accidentally word-splitting.
function quoteWord(rng, word) {
  const needsQuote = /[\s\t]/.test(word);
  const style = needsQuote ? rng.int(2) + 1 : rng.int(3); // 0=bare 1=single 2=double
  if (style === 1) return `'${word}'`;
  if (style === 2) return `"${word}"`;
  return word;
}

function genEcho(rng) {
  const count = rng.int(3) + 1;
  const words = [];
  for (let i = 0; i < count; i += 1) {
    words.push(quoteWord(rng, rng.pick(SAFE_WORDS)));
  }
  // Sometimes use -n (no trailing newline) to exercise that path.
  const flag = rng.int(4) === 0 ? "-n " : "";
  return { code: `echo ${flag}${words.join(" ")}`, note: null };
}

function genPrintf(rng) {
  const choice = rng.int(3);
  if (choice === 0) {
    return { code: `printf '%d\\n' ${rng.pick(SMALL_INTS)}`, note: null };
  }
  if (choice === 1) {
    return {
      code: `printf '%s-%s\\n' ${quoteWord(rng, rng.pick(SAFE_WORDS))} ${quoteWord(rng, rng.pick(SAFE_WORDS))}`,
      note: null,
    };
  }
  return {
    code: `printf '[%5d]\\n' ${rng.pick(SMALL_INTS)}`,
    note: null,
  };
}

function genArith(rng) {
  const ops = ["+", "-", "*", "/", "%"];
  const a = rng.pick(SMALL_INTS);
  let b = rng.pick(SMALL_INTS);
  const op = rng.pick(ops);
  // Avoid divide/mod by zero — both bash and ag-bash error, but the exact
  // message/exit differs and that is not an interesting compat signal here.
  if ((op === "/" || op === "%") && b === 0) b = 1;
  const c = rng.pick(SMALL_INTS);
  const expr =
    rng.int(2) === 0 ? `${a} ${op} ${b}` : `(${a} ${op} ${b}) + ${c}`;
  return { code: `echo $(( ${expr} ))`, note: null };
}

function genVarExpand(rng) {
  const name = rng.pick(VAR_NAMES);
  const value = rng.pick(SAFE_WORDS);
  const quoted = rng.int(2) === 0 ? `"$${name}"` : `$${name}`;
  return { code: `${name}='${value}'; echo ${quoted}`, note: null };
}

function genStringOp(rng) {
  const name = rng.pick(VAR_NAMES);
  const value = rng.pick(SAFE_WORDS);
  const op = rng.int(4);
  if (op === 0) {
    // Length.
    return { code: `${name}='${value}'; echo "\${#${name}}"`, note: null };
  }
  if (op === 1) {
    // Substring (offset:length).
    const off = rng.int(3);
    const len = rng.int(4) + 1;
    return {
      code: `${name}='${value}'; echo "\${${name}:${off}:${len}}"`,
      note: null,
    };
  }
  if (op === 2) {
    // Upper-case — a bash 4+ feature; host bash here is 3.2, so annotate.
    return {
      code: `${name}='${value}'; echo "\${${name}^^}"`,
      note: "uppercase-expansion (bash 4+; host bash may not support)",
    };
  }
  // Default-value expansion.
  return { code: `echo "\${${name}:-fallback}"`, note: null };
}

function genPipe(rng) {
  const choice = rng.int(4);
  if (choice === 0) {
    const n = rng.int(4) + 1;
    const lines = [];
    for (let i = 0; i < n; i += 1) lines.push(rng.pick(SAFE_WORDS));
    const joined = lines.join("\\n");
    return { code: `printf '%b\\n' '${joined}' | wc -l`, note: null };
  }
  if (choice === 1) {
    return {
      code: `printf '%s\\n' ${quoteWord(rng, rng.pick(SAFE_WORDS))} | tr 'a-z' 'A-Z'`,
      note: null,
    };
  }
  if (choice === 2) {
    const needle = rng.pick(["a", "o", "e", "x", "z"]);
    return {
      code: `printf 'alpha\\nbeta\\ngamma\\n' | grep '${needle}'`,
      note: null,
    };
  }
  return {
    code: `printf 'c\\na\\nb\\n' | sort | head -n ${rng.int(3) + 1}`,
    note: null,
  };
}

function genForLoop(rng) {
  const name = rng.pick(VAR_NAMES);
  const choice = rng.int(2);
  if (choice === 0) {
    const items = [];
    const n = rng.int(3) + 2;
    for (let i = 0; i < n; i += 1) items.push(rng.pick(SAFE_WORDS));
    const list = items.map((w) => `'${w}'`).join(" ");
    return {
      code: `for ${name} in ${list}; do echo "$${name}"; done`,
      note: null,
    };
  }
  // C-style numeric for-loop.
  const limit = rng.int(4) + 2;
  return {
    code: `for (( ${name}=0; ${name}<${limit}; ${name}++ )); do echo "$${name}"; done`,
    note: null,
  };
}

function genWhileLoop(rng) {
  const name = rng.pick(VAR_NAMES);
  const limit = rng.int(4) + 1;
  return {
    code: `${name}=0; while [ "$${name}" -lt ${limit} ]; do echo "$${name}"; ${name}=$(( ${name} + 1 )); done`,
    note: null,
  };
}

function genTest(rng) {
  const choice = rng.int(3);
  if (choice === 0) {
    const a = rng.pick(SMALL_INTS);
    const b = rng.pick(SMALL_INTS);
    const cmp = rng.pick(["-eq", "-ne", "-lt", "-gt", "-le", "-ge"]);
    return {
      code: `if [ ${a} ${cmp} ${b} ]; then echo yes; else echo no; fi`,
      note: null,
    };
  }
  if (choice === 1) {
    const w = rng.pick(SAFE_WORDS);
    return {
      code: `if [ -z '${w}' ]; then echo empty; else echo nonempty; fi`,
      note: null,
    };
  }
  const w = rng.pick(SAFE_WORDS);
  return { code: `[ -n '${w}' ] && echo present || echo absent`, note: null };
}

const GENERATORS = Object.freeze([
  genEcho,
  genPrintf,
  genArith,
  genVarExpand,
  genStringOp,
  genPipe,
  genForLoop,
  genWhileLoop,
  genTest,
]);

function generateSnippet(rng) {
  return rng.pick(GENERATORS)(rng);
}

// ---------------------------------------------------------------------------
// Execution + comparison.
// ---------------------------------------------------------------------------

/**
 * Run a snippet through one engine and capture a normalized result.
 * @returns {{ stdout: string, exitCode: number, timedOut: boolean, spawnError: boolean }}
 */
function runEngine(file, args, snippet, timeoutMs) {
  try {
    const stdout = execFileSync(file, [...args, snippet], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return Object.freeze({
      stdout,
      exitCode: 0,
      timedOut: false,
      spawnError: false,
    });
  } catch (err) {
    // execFileSync throws on non-zero exit, timeout, and spawn failure.
    // Read fields off the error defensively (null-prototype, no dynamic keys).
    const status = typeof err?.status === "number" ? err.status : null;
    const signal = typeof err?.signal === "string" ? err.signal : null;
    const stdoutBuf = err?.stdout;
    const stdout =
      typeof stdoutBuf === "string"
        ? stdoutBuf
        : stdoutBuf
          ? String(stdoutBuf)
          : "";
    const timedOut = signal === "SIGTERM" && status === null;
    // A spawn failure (ENOENT etc.) has no status and no signal.
    const spawnError = status === null && signal === null && !timedOut;
    return Object.freeze({
      stdout,
      exitCode: status === null ? -1 : status,
      timedOut,
      spawnError,
    });
  }
}

// Normalize stdout so trivial trailing-whitespace differences are not flagged.
function normalizeStdout(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trimEnd();
}

function compareResults(real, ours) {
  const reasons = [];
  if (normalizeStdout(real.stdout) !== normalizeStdout(ours.stdout)) {
    reasons.push("stdout");
  }
  if (real.exitCode !== ours.exitCode) {
    reasons.push("exitCode");
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// CLI argument parsing.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    iterations: 200,
    seed: 1,
    timeout: 5000,
    out: resolve(PKG_ROOT, "fuzz-divergences.json"),
    bash: "bash",
    bin: resolve(PKG_ROOT, "dist/bin/ag-bash.js"),
    failOnDivergence: false,
    verbose: false,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    i += 1;
    // Read the next token for value-taking flags, advancing the cursor past it.
    const next = argv[i];
    if (arg === "--iterations") {
      opts.iterations = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--seed") {
      opts.seed = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--timeout") {
      opts.timeout = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--out") {
      opts.out = resolve(next);
      i += 1;
    } else if (arg === "--bash") {
      opts.bash = next;
      i += 1;
    } else if (arg === "--bin") {
      opts.bin = resolve(next);
      i += 1;
    } else if (arg === "--fail-on-divergence") {
      opts.failOnDivergence = true;
    } else if (arg === "--verbose") {
      opts.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      opts.help = true;
    }
  }
  if (!Number.isFinite(opts.iterations) || opts.iterations <= 0) {
    opts.iterations = 200;
  }
  if (!Number.isFinite(opts.seed)) opts.seed = 1;
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) opts.timeout = 5000;
  return Object.freeze(opts);
}

const HELP_TEXT = `differential-fuzz.js — ag-bash vs host bash compat fuzzer

Usage:
  node scripts/differential-fuzz.js [options]

Options:
  --iterations N         snippets to generate (default 200)
  --seed S               xorshift32 seed (default 1, reproducible)
  --timeout MS           per-snippet per-engine timeout (default 5000)
  --out FILE             divergence report path (default fuzz-divergences.json)
  --bash PATH            host bash binary (default: bash on PATH)
  --bin PATH             built ag-bash CLI (default dist/bin/ag-bash.js)
  --fail-on-divergence   exit 1 if any divergence found (CI mode)
  --verbose              print each divergence as it is found
  -h, --help             show this help
`;

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (!existsSync(opts.bin)) {
    process.stderr.write(
      `error: ag-bash CLI not found at ${opts.bin}\n` +
        `       run \`pnpm build\` in packages/bash first, or pass --bin <path>.\n`,
    );
    return 2;
  }

  // Verify host bash actually runs before we start the loop.
  const bashProbe = runEngine(opts.bash, ["-c"], "echo ok", opts.timeout);
  if (bashProbe.spawnError || normalizeStdout(bashProbe.stdout) !== "ok") {
    process.stderr.write(
      `error: host bash not usable at "${opts.bash}" (spawn/probe failed).\n`,
    );
    return 2;
  }

  const rng = createPrng(opts.seed);
  const realArgs = ["-c"];
  const oursArgs = [opts.bin, "-c"];
  const divergences = [];
  let annotatedSkips = 0;
  let timeoutQuarantine = 0;

  const startedAt = process.hrtime.bigint();

  for (let i = 0; i < opts.iterations; i += 1) {
    const { code, note } = generateSnippet(rng);

    // Real bash:  bash -c <snippet>            (runEngine appends <snippet>)
    // ag-bash:    node dist/bin/ag-bash.js -c <snippet>
    const realRun = runEngine(opts.bash, realArgs, code, opts.timeout);
    const oursRun = runEngine("node", oursArgs, code, opts.timeout);

    // Quarantine harness/perf failures BEFORE comparing. A timeout or spawn
    // error (each surfaces as exitCode -1) is not a stdout/exitCode COMPAT
    // divergence — it is a property of this machine's load + the per-process
    // cold-start cost (~1.3s/ag-bash invocation), and is non-deterministic.
    // Counting it as a divergence made --fail-on-divergence a flaky CI gate.
    if (
      realRun.timedOut ||
      oursRun.timedOut ||
      realRun.spawnError ||
      oursRun.spawnError
    ) {
      timeoutQuarantine += 1;
      if (opts.verbose) {
        process.stderr.write(`quarantine (timeout/spawn): ${code}\n`);
      }
      continue;
    }

    const reasons = compareResults(realRun, oursRun);
    if (reasons.length === 0) continue;

    // If the snippet is flagged as a known host-version-specific construct and
    // ONLY stdout diverges (not a crash), annotate + skip rather than report.
    if (note && reasons.length === 1 && reasons[0] === "stdout") {
      annotatedSkips += 1;
      if (opts.verbose) {
        process.stderr.write(`skip (annotated: ${note}): ${code}\n`);
      }
      continue;
    }

    const record = Object.freeze({
      snippet: code,
      note,
      reasons,
      real: Object.freeze({
        stdout: realRun.stdout,
        exitCode: realRun.exitCode,
        timedOut: realRun.timedOut,
      }),
      agbash: Object.freeze({
        stdout: oursRun.stdout,
        exitCode: oursRun.exitCode,
        timedOut: oursRun.timedOut,
      }),
    });
    divergences.push(record);

    if (opts.verbose) {
      process.stderr.write(
        `DIVERGE [${reasons.join("+")}] ${code}\n` +
          `  real : exit=${realRun.exitCode} out=${JSON.stringify(normalizeStdout(realRun.stdout))}\n` +
          `  agbsh: exit=${oursRun.exitCode} out=${JSON.stringify(normalizeStdout(oursRun.stdout))}\n`,
      );
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  const report = Object.freeze({
    seed: opts.seed,
    iterations: opts.iterations,
    ran: opts.iterations,
    divergences: divergences.length,
    annotatedSkips,
    timeoutQuarantine,
    elapsedMs: Math.round(elapsedMs),
    bash: opts.bash,
    bin: opts.bin,
    items: divergences,
  });

  writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(
    `\nDifferential fuzz complete (seed=${opts.seed})\n` +
      `  ran:               ${report.ran}\n` +
      `  divergences:       ${report.divergences}\n` +
      `  annotated skips:   ${report.annotatedSkips}\n` +
      `  timeout quarantine:${report.timeoutQuarantine}\n` +
      `  elapsed:           ${report.elapsedMs}ms\n` +
      `  report written to: ${opts.out}\n`,
  );

  if (divergences.length > 0) {
    // Show up to 3 example divergences inline for quick triage.
    const sample = divergences.slice(0, 3);
    process.stdout.write(`\nExample divergences:\n`);
    for (const d of sample) {
      process.stdout.write(
        `  [${d.reasons.join("+")}] ${d.snippet}\n` +
          `    real : exit=${d.real.exitCode} out=${JSON.stringify(normalizeStdout(d.real.stdout))}\n` +
          `    agbsh: exit=${d.agbash.exitCode} out=${JSON.stringify(normalizeStdout(d.agbash.stdout))}\n`,
      );
    }
  }

  if (opts.failOnDivergence && divergences.length > 0) return 1;
  return 0;
}

process.exit(main());
