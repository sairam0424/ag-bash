/**
 * Shell-compat scorecard + allowed-failures ratchet for the spec suites.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/spec-tests/**` runs imported upstream conformance suites (Oils for bash,
 * plus awk/grep/sed/jq). A block of bash cases fail for known, documented
 * interpreter gaps (temp-env binding frames, numbered/duplicated fds, `$_`).
 * Closing them is weeks of work, but `vitest.unit.config.ts` includes
 * `src/**\/*.test.ts` with no spec exclusion, so the unit gate can never be green
 * while they are counted as plain failures — and a gate that is never green
 * cannot be made required, which strips every other gate of enforcement value.
 *
 * So this script converts "N absolute failures" into a REGRESSION DETECTOR:
 * a committed baseline of allowed failures plus a two-directional check.
 *
 * IT FAILS (exit 1) IN BOTH DIRECTIONS
 * ------------------------------------
 *   (a) NEW FAILURE   — a failing case that is not in the baseline. A regression.
 *   (b) STALE ENTRY   — a baseline entry whose case now passes, is skipped, or no
 *                       longer exists. Skipping this direction is exactly how
 *                       allowed-failure lists rot: a fixed case leaves an entry
 *                       behind that permanently re-permits that same failure.
 *                       The spec harness already enforces this shape for `## SKIP`
 *                       markers (it fails on UNEXPECTED PASS); this mirrors it.
 *
 * ...AND ON ANYTHING RED IT CANNOT BUCKET
 * ---------------------------------------
 * Not every test under `src/spec-tests/**` is a conformance case: `runner.test.ts`
 * unit-tests the harness itself, and each suite may carry a suite-level guard
 * (`it("All test files are currently skipped")`) that has no case file. Those are
 * NOT spec cases and must stay out of the scorecard — but "not a spec case" must
 * never collapse into "not checked". This lane is the only place they are
 * collected at all (`vitest.unit.config.ts` excludes `**\/spec-tests/**`), so a
 * non-spec test that PASSES is ignored quietly while one that FAILS aborts the
 * gate. Dropping them wholesale is how a deliberately-failing test sat in
 * `src/spec-tests/` while this script printed `[OK]` and exited 0.
 *
 * KEY FORMAT — `<case-file>::<case name>`
 * --------------------------------------
 * Deliberately NOT keyed on line number: upstream re-imports shift every line in
 * a case file, which would invalidate the whole baseline and force a blind
 * re-accept. Case names survive re-import.
 *
 * The vitest title is `[L<line>] <name>: <script preview>`, so the name is not
 * directly recoverable from the title alone (names may contain ": "). For the
 * bash suite the reported line number is used TRANSIENTLY to look up the exact
 * `#### <name>` header in the case file; only the resolved name is ever stored.
 * A repeated name inside one file gets a `#<n>` occurrence suffix (1st occurrence
 * unsuffixed), which is order-stable rather than position-stable.
 *
 * The awk/grep/sed/jq suites have heterogeneous case formats whose headers are
 * not recoverable from the reported line, so they fall back to the coarser
 * `<case-file>::<title minus line prefix>`. They are 100% green today and hold no
 * baseline entries, so the fallback only ever names a brand-new regression. If a
 * suite there ever needs an allowance, teach `resolveCaseName()` its header
 * format first.
 *
 * USAGE
 *   node scripts/check-spec-ratchet.js                # run suites, check, scorecard
 *   node scripts/check-spec-ratchet.js --report f.json  # reuse an existing vitest JSON report
 *   node scripts/check-spec-ratchet.js --update       # re-baseline (review the diff!)
 *   node scripts/check-spec-ratchet.js --verbose      # stream the vitest run
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO_ROOT, "packages/bash/spec-baseline.json");
const BASELINE_REL = "packages/bash/spec-baseline.json";
const SPEC_TESTS_DIR = join(REPO_ROOT, "packages/bash/src/spec-tests");
const SPEC_TESTS_GLOB = "src/spec-tests/";

/** Suites whose case files expose a recoverable `#### <name>` header. */
const KEYED_SUITES = new Set(["bash"]);

/**
 * A conformance suite is a DIRECTORY under `src/spec-tests/` holding its cases in
 * `<suite>/cases/`, so `dirname()` of a suite test file names the suite. It
 * returns "." for a file sitting directly in the spec-tests root, which is
 * therefore a colocated unit test (runner.test.ts) and not a suite at all.
 * Keyed on layout rather than on a filename so a second such unit test needs no
 * change here.
 */
const NOT_A_SUITE = ".";

/**
 * Assertion statuses that are safe to ignore on a NON-spec test. Anything else —
 * a failure, or a status this script has never been taught — must reach a human
 * instead of being skipped as unbucketable.
 */
const IGNORABLE_NON_SPEC_STATUSES = new Set([
  "passed",
  "skipped",
  "pending",
  "todo",
]);

/** Only these top-level keys are allowed in the baseline file. */
const BASELINE_KEYS = new Set([
  "description",
  "generatedBy",
  "allowedFailures",
]);

const BASELINE_DESCRIPTION =
  "Known-failing spec cases, allowed as a ratchet floor. Enforced in BOTH directions by scripts/check-spec-ratchet.js: a failure missing from this list is a regression, and an entry that now passes is stale and must be removed. Never key on line numbers - see the script header.";
const BASELINE_GENERATED_BY = "node scripts/check-spec-ratchet.js --update";

const LINE_PREFIX = /^\[L(\d+)\] /;
const CASE_HEADER_PREFIX = "#### ";

function parseArgs(argv) {
  const options = new Map([
    ["report", null],
    ["update", false],
    ["verbose", false],
    ["help", false],
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--update") {
      options.set("update", true);
    } else if (arg === "--verbose") {
      options.set("verbose", true);
    } else if (arg === "--help" || arg === "-h") {
      options.set("help", true);
    } else if (arg === "--report") {
      i += 1;
      const value = argv[i];
      if (!value) {
        fail("--report requires a path to a vitest JSON report");
      }
      options.set("report", resolve(value));
    } else if (arg.startsWith("--report=")) {
      options.set("report", resolve(arg.slice("--report=".length)));
    } else {
      fail(`Unknown argument: ${arg}\nRun with --help for usage.`);
    }
  }

  return options;
}

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ report */

/**
 * Run the spec suites and return the parsed vitest JSON report.
 * The suites exit non-zero while known failures exist, so the exit code is
 * intentionally ignored - a missing/unparseable report is the real failure.
 */
function runSpecSuites(verbose) {
  const tempDir = mkdtempSync(join(tmpdir(), "ag-spec-ratchet-"));
  const reportPath = join(tempDir, "spec-report.json");

  const args = [
    "--filter",
    "@ag-bash/bash",
    "exec",
    "vitest",
    "run",
    "--testTimeout=120000",
    "--hookTimeout=120000",
    SPEC_TESTS_GLOB,
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ];

  console.log(`Running spec suites (pnpm ${args.join(" ")})...`);
  const result = spawnSync("pnpm", args, {
    cwd: REPO_ROOT,
    stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  let report = null;
  let readFailure = null;
  try {
    report = readReport(reportPath);
  } catch (error) {
    readFailure = describeError(error);
  }
  // Clean up before any process.exit() - fail() never returns, so this cannot
  // live in a finally block.
  rmSync(tempDir, { recursive: true, force: true });

  if (readFailure !== null) {
    if (!verbose) {
      console.error(result.stdout ?? "");
      console.error(result.stderr ?? "");
    }
    fail(
      `Could not read the vitest JSON report (${readFailure}).\n` +
        `vitest exit code: ${result.status}\n` +
        "Re-run with --verbose to see the suite output.",
    );
  }
  return report;
}

function readReport(reportPath) {
  const raw = readFileSync(reportPath, "utf8");
  const report = JSON.parse(raw);
  if (!Array.isArray(report.testResults)) {
    throw new Error("report has no testResults array");
  }
  return report;
}

/* --------------------------------------------------------------- case keys */

const headerCache = new Map();

/**
 * Map every `#### <name>` header line in a case file to its resolved name and
 * 1-based occurrence index (for names that repeat inside one file).
 */
function caseHeaders(caseFileRel) {
  const cached = headerCache.get(caseFileRel);
  if (cached) {
    return cached;
  }

  const byLine = new Map();
  const seen = new Map();
  const lines = readFileSync(join(SPEC_TESTS_DIR, caseFileRel), "utf8").split(
    "\n",
  );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith(CASE_HEADER_PREFIX)) {
      continue;
    }
    const name = line.slice(CASE_HEADER_PREFIX.length).trim();
    const occurrence = (seen.get(name) ?? 0) + 1;
    seen.set(name, occurrence);
    byLine.set(i + 1, { name, occurrence });
  }

  headerCache.set(caseFileRel, byLine);
  return byLine;
}

/**
 * Resolve the stable case name for one reported test.
 * Returns null when the bash-suite title cannot be matched to a case header,
 * which means the harness title format drifted and must be fixed here.
 */
function resolveCaseName(suite, caseFileRel, title) {
  const match = LINE_PREFIX.exec(title);
  const rest = match ? title.slice(match[0].length) : title;

  if (!KEYED_SUITES.has(suite) || !match) {
    return rest;
  }

  const header = caseHeaders(caseFileRel).get(Number(match[1]));
  if (!header) {
    return null;
  }
  if (rest !== header.name && !rest.startsWith(`${header.name}:`)) {
    return null;
  }
  return header.occurrence > 1
    ? `${header.name}#${header.occurrence}`
    : header.name;
}

/** Flatten a vitest JSON report into keyed spec cases. */
function collectCases(report) {
  const cases = [];
  const nonSpecFailures = [];
  const unresolved = [];
  const seenKeys = new Map();

  for (const fileResult of report.testResults) {
    const specTestPath = String(fileResult.name).split("/spec-tests/")[1];
    if (!specTestPath) {
      fail(
        `Report contains a test file outside src/spec-tests/: ${fileResult.name}`,
      );
    }
    const suite = dirname(specTestPath);

    for (const assertion of fileResult.assertionResults) {
      // A conformance case needs BOTH a suite directory (its case file lives in
      // `<suite>/cases/`) and a case-file group title. Anything else is a plain
      // test that merely sits under src/spec-tests/: a colocated unit test, or a
      // suite-level guard like "All test files are currently skipped" that has
      // no case file. Those get no scorecard bucket - but see below: not being a
      // spec case is not permission to ignore a red one.
      const group = assertion.ancestorTitles[1];
      if (suite === NOT_A_SUITE || !group) {
        if (!IGNORABLE_NON_SPEC_STATUSES.has(assertion.status)) {
          nonSpecFailures.push({
            location: specTestPath,
            name: [...assertion.ancestorTitles, assertion.title].join(" > "),
            status: assertion.status,
          });
        }
        continue;
      }
      const caseFileRel = join(suite, "cases", group);
      const name = resolveCaseName(suite, caseFileRel, assertion.title);
      if (name === null) {
        unresolved.push(`${caseFileRel} :: ${assertion.title}`);
        continue;
      }

      const baseKey = `${caseFileRel}::${name}`;
      const collisions = (seenKeys.get(baseKey) ?? 0) + 1;
      seenKeys.set(baseKey, collisions);
      if (collisions > 1 && KEYED_SUITES.has(suite)) {
        // resolveCaseName() already disambiguates repeated `#### ` names, so a
        // collision here is a resolver bug, not upstream data - fail loudly
        // rather than silently merging two cases into one baseline entry.
        fail(
          `Duplicate spec key in keyed suite: ${baseKey}\n` +
            "Two cases resolved to the same identifier, so the baseline cannot\n" +
            "distinguish them. Fix the occurrence-suffix logic in resolveCaseName().",
        );
      }
      // Non-keyed suites key on the full title, which upstream may repeat
      // verbatim; disambiguate by order of appearance.
      const key = collisions > 1 ? `${baseKey}#${collisions}` : baseKey;

      cases.push({
        key,
        suite,
        caseFileRel,
        title: assertion.title,
        status: assertion.status,
      });
    }
  }

  if (nonSpecFailures.length > 0) {
    // No scorecard here on purpose: runner.test.ts covers the very outcome
    // classification every bucket below is derived from, so while it is red the
    // pass/skip/fail split is not trustworthy enough to print as a score.
    fail(
      `${nonSpecFailures.length} non-conformance test(s) under src/spec-tests/ did not pass:\n` +
        nonSpecFailures
          .map(
            (entry) =>
              `  ${entry.status.toUpperCase()}  ${entry.location} :: ${entry.name}`,
          )
          .join("\n") +
        "\n\nThese are not spec cases, so they get no scorecard bucket and no\n" +
        `${BASELINE_REL} entry - the baseline is only for conformance cases.\n` +
        "Fix the test. This gate is the only one that collects them, so ignoring\n" +
        "it here means nothing enforces them at all.\n" +
        "See the failure detail with: node scripts/check-spec-ratchet.js --verbose",
    );
  }

  if (unresolved.length > 0) {
    fail(
      `Could not resolve ${unresolved.length} spec case name(s) to a "#### " header.\n` +
        "The spec harness test-title format changed; update resolveCaseName().\n" +
        unresolved
          .slice(0, 10)
          .map((entry) => `  ${entry}`)
          .join("\n"),
    );
  }

  return cases;
}

/* ---------------------------------------------------------------- baseline */

function loadBaseline() {
  let raw;
  try {
    raw = readFileSync(BASELINE_PATH, "utf8");
  } catch (error) {
    const detail = describeError(error);
    fail(
      `Could not read ${BASELINE_REL} (${detail}).\n` +
        `Create it with: ${BASELINE_GENERATED_BY}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = describeError(error);
    fail(`${BASELINE_REL} is not valid JSON (${detail}).`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${BASELINE_REL} must contain a JSON object.`);
  }

  const unknown = Object.keys(parsed).filter((key) => !BASELINE_KEYS.has(key));
  if (unknown.length > 0) {
    fail(
      `${BASELINE_REL} has unknown key(s): ${unknown.join(", ")}\n` +
        `Allowed keys: ${[...BASELINE_KEYS].join(", ")}`,
    );
  }

  const entries = parsed.allowedFailures;
  if (!Array.isArray(entries) || entries.some((e) => typeof e !== "string")) {
    fail(`${BASELINE_REL} "allowedFailures" must be an array of strings.`);
  }

  const sorted = sortKeys(entries);
  if (entries.join("\n") !== sorted.join("\n")) {
    fail(
      `${BASELINE_REL} "allowedFailures" must be sorted so diffs stay reviewable.\n` +
        `Fix with: ${BASELINE_GENERATED_BY}`,
    );
  }
  if (new Set(entries).size !== entries.length) {
    fail(
      `${BASELINE_REL} "allowedFailures" contains duplicate entries.\n` +
        `Fix with: ${BASELINE_GENERATED_BY}`,
    );
  }

  return entries;
}

function sortKeys(keys) {
  return [...keys].sort((a, b) => {
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  });
}

/** Write the baseline with one entry per line so a diff shows exact state changes. */
function writeBaseline(failingKeys) {
  const body = [
    "{",
    `  ${JSON.stringify("description")}: ${JSON.stringify(BASELINE_DESCRIPTION)},`,
    `  ${JSON.stringify("generatedBy")}: ${JSON.stringify(BASELINE_GENERATED_BY)},`,
    `  ${JSON.stringify("allowedFailures")}: [`,
    ...sortKeys(failingKeys).map(
      (key, index, all) =>
        `    ${JSON.stringify(key)}${index === all.length - 1 ? "" : ","}`,
    ),
    "  ]",
    "}",
    "",
  ].join("\n");
  writeFileSync(BASELINE_PATH, body);
}

/* --------------------------------------------------------------- scorecard */

function percent(part, whole) {
  if (whole === 0) {
    return "n/a";
  }
  return `${((part / whole) * 100).toFixed(2)}%`;
}

function printScorecard(cases, allowedSet) {
  const suites = new Map();
  const knownFailingByFile = new Map();
  const totals = new Map([
    ["total", 0],
    ["passing", 0],
    ["knownFailing", 0],
    ["newFailing", 0],
    ["skipped", 0],
  ]);

  for (const specCase of cases) {
    const suite =
      suites.get(specCase.suite) ??
      new Map([
        ["total", 0],
        ["passing", 0],
        ["knownFailing", 0],
        ["newFailing", 0],
        ["skipped", 0],
      ]);
    suites.set(specCase.suite, suite);

    const bump = (bucket) => {
      totals.set(bucket, totals.get(bucket) + 1);
      suite.set(bucket, suite.get(bucket) + 1);
    };

    bump("total");
    if (specCase.status === "passed") {
      bump("passing");
    } else if (specCase.status === "failed") {
      const known = allowedSet.has(specCase.key);
      bump(known ? "knownFailing" : "newFailing");
      if (known) {
        const bucket = knownFailingByFile.get(specCase.caseFileRel) ?? [];
        bucket.push(specCase.key.slice(specCase.caseFileRel.length + 2));
        knownFailingByFile.set(specCase.caseFileRel, bucket);
      }
    } else {
      bump("skipped");
    }
  }

  const total = totals.get("total");
  console.log("");
  console.log("Shell-compat scorecard (imported conformance suites)");
  console.log("===================================================");
  console.log(`  cases            ${String(total).padStart(6)}`);
  console.log(
    `  passing          ${String(totals.get("passing")).padStart(6)}  ${percent(totals.get("passing"), total)}`,
  );
  console.log(
    `  known-failing    ${String(totals.get("knownFailing")).padStart(6)}  ${percent(totals.get("knownFailing"), total)}  (baseline-allowed)`,
  );
  console.log(
    `  new failures     ${String(totals.get("newFailing")).padStart(6)}`,
  );
  console.log(
    `  skipped          ${String(totals.get("skipped")).padStart(6)}`,
  );

  console.log("");
  console.log("  suite    cases  passing  known-fail  new-fail  pass%");
  for (const suiteName of sortKeys([...suites.keys()])) {
    const suite = suites.get(suiteName);
    console.log(
      `  ${suiteName.padEnd(7)}` +
        `${String(suite.get("total")).padStart(7)}` +
        `${String(suite.get("passing")).padStart(9)}` +
        `${String(suite.get("knownFailing")).padStart(12)}` +
        `${String(suite.get("newFailing")).padStart(10)}` +
        `  ${percent(suite.get("passing"), suite.get("total"))}`,
    );
  }

  if (knownFailingByFile.size > 0) {
    console.log("");
    console.log("Known-failing by case file (parity backlog):");
    const byCount = [...knownFailingByFile.keys()].sort((a, b) => {
      const diff =
        knownFailingByFile.get(b).length - knownFailingByFile.get(a).length;
      return diff !== 0 ? diff : a < b ? -1 : 1;
    });
    for (const caseFileRel of byCount) {
      const names = knownFailingByFile.get(caseFileRel);
      console.log(`  ${String(names.length).padStart(3)}  ${caseFileRel}`);
      for (const name of sortKeys(names)) {
        console.log(`         - ${name}`);
      }
    }
  }

  return totals;
}

/* -------------------------------------------------------------------- main */

const HELP = `check-spec-ratchet - shell-compat scorecard + allowed-failures ratchet

  node scripts/check-spec-ratchet.js                   run the spec suites and check
  node scripts/check-spec-ratchet.js --report <file>   reuse a vitest JSON report
  node scripts/check-spec-ratchet.js --update          rewrite ${BASELINE_REL}
  node scripts/check-spec-ratchet.js --verbose         stream the vitest output

Exits non-zero on a new failure (regression), a stale baseline entry
(a case that now passes but is still listed), or any non-conformance test
under src/spec-tests/ that is red - no lane but this one collects those.
`;

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.get("help")) {
    console.log(HELP);
    return 0;
  }

  const reportPath = options.get("report");
  let report;
  if (reportPath) {
    try {
      report = readReport(reportPath);
    } catch (error) {
      const detail = describeError(error);
      fail(`Could not read report ${reportPath} (${detail}).`);
    }
  } else {
    report = runSpecSuites(options.get("verbose"));
  }

  const cases = collectCases(report);
  if (cases.length === 0) {
    fail(
      "No spec cases found in the report. The suites did not run - refusing to\n" +
        "accept an empty run as a green ratchet.",
    );
  }

  const failingKeys = cases
    .filter((specCase) => specCase.status === "failed")
    .map((specCase) => specCase.key);

  if (options.get("update")) {
    writeBaseline(failingKeys);
    printScorecard(cases, new Set(failingKeys));
    console.log("");
    console.log(
      `[UPDATED] ${BASELINE_REL} now allows ${failingKeys.length} failing case(s).`,
    );
    console.log("Review the diff: every added line re-permits a failure.");
    return 0;
  }

  const allowed = loadBaseline();
  const allowedSet = new Set(allowed);
  const failingSet = new Set(failingKeys);
  const byKey = new Map(cases.map((specCase) => [specCase.key, specCase]));

  const newFailures = cases.filter(
    (specCase) => specCase.status === "failed" && !allowedSet.has(specCase.key),
  );
  const staleEntries = allowed
    .filter((key) => !failingSet.has(key))
    .map((key) => {
      const specCase = byKey.get(key);
      if (!specCase) {
        return { key, reason: "no longer exists in the spec suites" };
      }
      return {
        key,
        reason:
          specCase.status === "passed"
            ? "now PASSES"
            : `is now ${specCase.status}`,
      };
    });

  printScorecard(cases, allowedSet);

  if (newFailures.length > 0) {
    console.error("");
    console.error(
      `[FAIL] ${newFailures.length} NEW spec failure(s) not in ${BASELINE_REL}:`,
    );
    for (const specCase of newFailures) {
      console.error(`  + ${specCase.key}`);
      console.error(`      vitest title: ${specCase.title}`);
    }
    console.error("");
    console.error(
      "These are regressions. Fix them, or - only with a written reason in the\n" +
        `commit message - re-baseline with: ${BASELINE_GENERATED_BY}`,
    );
  }

  if (staleEntries.length > 0) {
    console.error("");
    console.error(
      `[FAIL] ${staleEntries.length} STALE entr(y/ies) in ${BASELINE_REL}:`,
    );
    for (const entry of staleEntries) {
      console.error(`  - ${entry.key}`);
      console.error(`      ${entry.reason}`);
    }
    console.error("");
    console.error(
      "A stale entry permanently re-permits a failure that is already fixed.\n" +
        `Remove these lines, or run: ${BASELINE_GENERATED_BY}`,
    );
  }

  if (newFailures.length > 0 || staleEntries.length > 0) {
    return 1;
  }

  console.log("");
  console.log(
    `[OK] ${failingKeys.length} known failure(s), exactly matching ${BASELINE_REL}.`,
  );
  return 0;
}

process.exit(main());
