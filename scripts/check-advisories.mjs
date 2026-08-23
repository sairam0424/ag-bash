#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Reachability-aware supply-chain gate. Replaces the bare
// `pnpm audit --audit-level=high` that used to guard quality/release/publish/
// canary. That command swept the WHOLE workspace, so a `vitest > vite` or an
// `examples/website > next > postcss` advisory blocked a release even though no
// consumer of @ag-bash/bash, @ag-bash/mcp-server or @ag-bash/agent-bridge can
// reach it. Because the advisory DATABASE moves on its own schedule, that gate
// went red without a single dependency changing — a one-time version bump is
// not a fix for a recurring condition.
//
// This gate asks a narrower question: "is a high/critical advisory reachable
// from something we PUBLISH?" It BLOCKS on those, and reports the rest.
//
// WHAT THIS GATE NO LONGER CATCHES — on the record, deliberately:
//   1. A compromised build-time dependency (vitest, vite, esbuild, changesets).
//      Those run on CI runners that hold publish credentials and on maintainer
//      laptops, and esbuild bundles the shipped dist/. A hostile version is a
//      real path to a poisoned artifact, and it will now only WARN.
//   2. Advisories in examples/* — no longer blocking. Nothing in CI deploys
//      them today (examples.yml is build + typecheck only), but anyone who
//      deploys examples/website by hand is outside this gate's coverage.
//   3. Anything below the blocking level (default: high). Unchanged from before.
// Compensating controls kept intact: the non-blocking whole-workspace
// `pnpm audit` step in quality.yml and canary.yml, `npm audit signatures` on the
// publish paths, plus codeql.yml and dependency-review.yml.
//
// Reachability is decided primarily by (module, exact installed version)
// membership in the production closure of the publishable packages — NOT by the
// dependency path pnpm happens to print. That distinction is load-bearing: pnpm
// collapses `findings` to ONE representative path per (advisory, version), so
// the printed root is arbitrary when several roots resolve the same version. A
// path root is only consulted when no version is available, and an unrecognised
// root is treated as BLOCKING (fail closed).
//
// Usage:
//   node scripts/check-advisories.mjs
//   node scripts/check-advisories.mjs --level=critical
//   node scripts/check-advisories.mjs --audit-json=a.json \
//     --workspace-json=w.json --closure-json=c.json   # offline / fixture mode
//
// Exit codes: 0 = clean · 1 = gate failure · 2 = tool/report-shape failure.
//
// Layering: everything below `evaluateAdvisories` is pure — reports in, verdict
// out, no I/O and no process.exit — so the gate's own logic is unit-tested from
// checked-in fixtures in packages/bash/src/check-advisories.test.ts. `main()`
// is the only part that shells out, reads files or prints, and it runs only
// when this file is the process entry point.

const ROOT = resolve(import.meta.dirname, "..");
const SEVERITY_ORDER = ["info", "low", "moderate", "high", "critical"];
const DEFAULT_LEVEL = "high";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_REASON_LENGTH = 12;
// A workspace package is "publishable" when it lives under packages/ and is not
// marked private. `private` alone is not sufficient here: examples/bash-agent,
// examples/cjs-consumer and examples/custom-command all carry `private: false`
// yet are never published to npm.
const PUBLISHABLE_DIR = "packages";

const PUBLISHED = "published";
const UNKNOWN = "unknown";
const DEV = "dev";
const EXAMPLE = "example";
const CLASS_ORDER = [PUBLISHED, UNKNOWN, DEV, EXAMPLE];
const CLASS_LABEL = new Map([
  [PUBLISHED, "published (shipped to npm)"],
  [UNKNOWN, "unknown root (treated as shipped)"],
  [DEV, "root devDependency (build-time)"],
  [EXAMPLE, "examples/* (never published)"],
]);
// Only these classes can fail the run. UNKNOWN is here on purpose: if the gate
// cannot prove a finding is unreachable, it refuses to call it harmless.
const BLOCKING_CLASSES = new Set([PUBLISHED, UNKNOWN]);

/**
 * "This gate cannot produce a trustworthy result" — always exit 2, never a pass.
 * Thrown rather than exited so the pure layer can be called in-process (a unit
 * test must not be able to kill its own worker); `runCli` turns it back into the
 * same stderr block and the same exit code the CLI has always produced.
 */
class AdvisoryGateError extends Error {
  /** @param {string[]} lines */
  constructor(lines) {
    super(lines.join(" | "));
    this.name = "AdvisoryGateError";
    /** @type {string[]} */
    this.lines = lines;
  }
}

function hardFail(lines) {
  throw new AdvisoryGateError([].concat(lines));
}

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  // An unrecognised severity ranks above critical so a renamed severity can
  // never be filtered out by the level threshold.
  return index === -1 ? SEVERITY_ORDER.length : index;
}

function parseArgs(argv) {
  const options = {
    auditJson: null,
    workspaceJson: null,
    closureJson: null,
    manifestJson: null,
    level: DEFAULT_LEVEL,
    today: new Date().toISOString().slice(0, 10),
  };
  for (const arg of argv) {
    const equals = arg.indexOf("=");
    const key = equals === -1 ? arg : arg.slice(0, equals);
    const value = equals === -1 ? "" : arg.slice(equals + 1);
    if (key === "--audit-json") {
      options.auditJson = value;
    } else if (key === "--workspace-json") {
      options.workspaceJson = value;
    } else if (key === "--closure-json") {
      options.closureJson = value;
    } else if (key === "--manifest-json") {
      options.manifestJson = value;
    } else if (key === "--level") {
      options.level = value.toLowerCase();
    } else if (key === "--today") {
      options.today = value;
    } else if (key === "--help" || key === "-h") {
      console.log(
        "Usage: node scripts/check-advisories.mjs [--level=high]" +
          " [--today=YYYY-MM-DD] [--audit-json=FILE]" +
          " [--workspace-json=FILE] [--closure-json=FILE] [--manifest-json=FILE]",
      );
      process.exit(0);
    } else {
      hardFail([`unrecognised option: ${key}`, "run with --help for usage."]);
    }
  }
  if (SEVERITY_ORDER.indexOf(options.level) === -1) {
    hardFail([
      `--level must be one of ${SEVERITY_ORDER.join("|")}, got "${options.level}"`,
    ]);
  }
  if (!ISO_DATE.test(options.today)) {
    hardFail([`--today must be YYYY-MM-DD, got "${options.today}"`]);
  }
  return options;
}

function readJsonFile(file, label) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    hardFail([`could not read ${label} from ${file}`]);
  }
  try {
    return JSON.parse(text);
  } catch {
    hardFail([`${label} at ${file} is not valid JSON`]);
  }
}

function runPnpmJson(args, label) {
  const result = spawnSync("pnpm", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) {
    hardFail([
      `could not execute \`pnpm ${args.join(" ")}\` (${label}).`,
      "Is pnpm on PATH? This gate never passes by default when it cannot run.",
    ]);
  }
  // `pnpm audit` exits 1 whenever ANY advisory exists at all, so a non-zero exit
  // carries no information and must not be treated as an error. The only
  // trustworthy signal is whether stdout parses into the shape we expect: a
  // registry or tool failure yields prose (or nothing) and lands in hardFail
  // below instead of silently reading as "clean".
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (stdout === "") {
    const tail =
      typeof result.stderr === "string"
        ? result.stderr.trim().split("\n").slice(-4)
        : [];
    hardFail(
      [
        `\`pnpm ${args.join(" ")}\` (${label}) produced no JSON on stdout.`,
      ].concat(tail),
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    hardFail([
      `\`pnpm ${args.join(" ")}\` (${label}) did not emit parseable JSON.`,
      "Run it by hand; the report format may have changed.",
    ]);
  }
}

/** Uppercased identifier set for an advisory: GHSA id, npm id, and every CVE. */
function advisoryIds(advisory, key) {
  const ids = new Set([String(key).toUpperCase()]);
  if (typeof advisory.github_advisory_id === "string") {
    ids.add(advisory.github_advisory_id.toUpperCase());
  }
  if (advisory.id !== undefined && advisory.id !== null) {
    ids.add(String(advisory.id).toUpperCase());
  }
  if (Array.isArray(advisory.cves)) {
    for (const cve of advisory.cves) {
      if (typeof cve === "string" && cve !== "") {
        ids.add(cve.toUpperCase());
      }
    }
  }
  return ids;
}

/**
 * Flatten `pnpm audit --json` into one record per (advisory, version, path).
 * The shape is validated rather than assumed: the report differs across pnpm
 * versions, and guessing here would silently downgrade the gate.
 */
function normalizeAudit(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    hardFail(["pnpm audit did not return a JSON object."]);
  }
  const advisories = report.advisories;
  if (
    !advisories ||
    typeof advisories !== "object" ||
    Array.isArray(advisories)
  ) {
    hardFail([
      "pnpm audit JSON has no `advisories` object.",
      "The report shape has changed. This gate refuses to guess: inspect",
      "`pnpm audit --json` and update scripts/check-advisories.mjs first.",
    ]);
  }
  const records = [];
  for (const [key, advisory] of Object.entries(advisories)) {
    if (!advisory || typeof advisory !== "object") {
      hardFail([
        `advisory "${key}" is not an object; the report shape is unrecognised.`,
      ]);
    }
    const shared = {
      label:
        typeof advisory.github_advisory_id === "string" &&
        advisory.github_advisory_id !== ""
          ? advisory.github_advisory_id
          : `npm-${key}`,
      ids: advisoryIds(advisory, key),
      severity:
        typeof advisory.severity === "string"
          ? advisory.severity.toLowerCase()
          : "unrecognised",
      moduleName:
        typeof advisory.module_name === "string"
          ? advisory.module_name
          : String(key),
      title: typeof advisory.title === "string" ? advisory.title : "(no title)",
    };
    const findings = Array.isArray(advisory.findings) ? advisory.findings : [];
    if (findings.length === 0) {
      // No findings means no version and no path, so reachability cannot be
      // established at all. Fail closed by landing in the UNKNOWN class.
      records.push({ ...shared, version: null, path: null });
      continue;
    }
    for (const finding of findings) {
      const version =
        finding && typeof finding.version === "string" && finding.version !== ""
          ? finding.version
          : null;
      const paths =
        finding && Array.isArray(finding.paths) && finding.paths.length > 0
          ? finding.paths
          : [null];
      for (const path of paths) {
        records.push({
          ...shared,
          version,
          path: typeof path === "string" && path !== "" ? path : null,
        });
      }
    }
  }
  return records;
}

/**
 * Describe one workspace package. pnpm names an audit path root after the
 * workspace-relative directory with `/` replaced by `__` (`packages/bash` →
 * `packages__bash`); the workspace root itself is `.`.
 */
function describeWorkspacePackage(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.path !== "string") {
    return null;
  }
  const rel = relative(ROOT, entry.path);
  const segments = rel === "" ? [] : rel.split(sep);
  const isRoot = segments.length === 0;
  return {
    name: typeof entry.name === "string" ? entry.name : rel,
    token: isRoot ? "." : segments.join("__"),
    isRoot,
    publishable:
      !isRoot && segments[0] === PUBLISHABLE_DIR && entry.private !== true,
    dependencies: entry.dependencies,
  };
}

function normalizeWorkspace(listing) {
  if (!Array.isArray(listing)) {
    hardFail([
      "`pnpm list --recursive --depth=-1 --json` did not return an array.",
      "Cannot map audit path roots onto workspace packages; refusing to pass.",
    ]);
  }
  const packages = [];
  for (const entry of listing) {
    const described = describeWorkspacePackage(entry);
    if (described !== null) {
      packages.push(described);
    }
  }
  if (!packages.some((pkg) => pkg.publishable)) {
    hardFail([
      `no publishable workspace package found under ${PUBLISHABLE_DIR}/.`,
      "Every advisory would then look unreachable. Refusing to report a false clean.",
    ]);
  }
  return packages;
}

/**
 * Every `name@version` in the production dependency closure of what we publish.
 *
 * Two traps are handled here, both discovered the hard way:
 *  - `pnpm list --recursive` silently caps the tree at direct dependencies even
 *    with `--depth=Infinity`. Only the `--filter <dir-glob>` form expands fully,
 *    which is why the closure comes from its own invocation.
 *  - pnpm marks repeated subtrees `deduped` and omits their children, so a naive
 *    "skip anything already seen" walk can drop a whole subtree if it meets the
 *    deduped copy first. Membership and expansion are therefore tracked
 *    separately: every node counts, and any node that carries children is
 *    expanded once.
 */
function productionClosure(entries) {
  const closure = new Set();
  const expanded = new Set();
  const stack = [];
  let directCount = 0;
  for (const entry of entries) {
    stack.push(entry.dependencies);
    directCount += Object.keys(
      entry.dependencies ?? Object.create(null),
    ).length;
  }
  while (stack.length > 0) {
    const dependencies = stack.pop();
    if (!dependencies || typeof dependencies !== "object") {
      continue;
    }
    for (const [name, node] of Object.entries(dependencies)) {
      if (!node || typeof node !== "object") {
        continue;
      }
      const key = `${name}@${node.version}`;
      closure.add(key);
      if (node.dependencies && !expanded.has(key)) {
        expanded.add(key);
        stack.push(node.dependencies);
      }
    }
  }
  if (directCount > 0 && closure.size <= directCount) {
    hardFail([
      `the production closure (${closure.size}) is no larger than the direct`,
      `dependency count (${directCount}), so the dependency tree was almost`,
      "certainly truncated and unreachable findings would be under-reported.",
      "Check the `pnpm list` flags — `--recursive` ignores `--depth=Infinity`.",
    ]);
  }
  return closure;
}

function normalizeClosureSource(listing) {
  if (!Array.isArray(listing) || listing.length === 0) {
    hardFail([
      `\`pnpm list --prod --depth=Infinity --filter ./${PUBLISHABLE_DIR}/*\` returned no packages.`,
      "Refusing to report a clean result from an empty closure.",
    ]);
  }
  const entries = [];
  for (const entry of listing) {
    const described = describeWorkspacePackage(entry);
    if (described?.publishable) {
      entries.push(described);
    }
  }
  if (entries.length === 0) {
    hardFail([
      `the closure listing contained no publishable package under ${PUBLISHABLE_DIR}/.`,
      "Refusing to report a clean result from an empty closure.",
    ]);
  }
  return entries;
}

function classify(record, closure, tokens) {
  if (
    record.version !== null &&
    closure.has(`${record.moduleName}@${record.version}`)
  ) {
    return {
      reach: PUBLISHED,
      why: "resolved version is in the publishable production closure",
    };
  }
  const root = record.path === null ? null : record.path.split(">")[0];
  if (root === null) {
    return { reach: UNKNOWN, why: "advisory reported no dependency path" };
  }
  if (root === ".") {
    return { reach: DEV, why: "workspace-root devDependency path" };
  }
  const pkg = tokens.get(root);
  if (pkg === undefined) {
    return {
      reach: UNKNOWN,
      why: `path root "${root}" is not a known workspace package`,
    };
  }
  if (pkg.publishable) {
    return { reach: PUBLISHED, why: `dependency path rooted at ${pkg.name}` };
  }
  return {
    reach: EXAMPLE,
    why: `dependency path rooted at ${pkg.name} (not published)`,
  };
}

/**
 * `auditConfig.ignoreCves` in the root package.json. Every entry MUST carry a
 * reason and an expiry date, and this script enforces the expiry — an ignore
 * list without an enforced expiry is exactly how a permanent exception gets
 * created by accident.
 *
 *   "auditConfig": {
 *     "ignoreCves": [
 *       { "id": "GHSA-xxxx-yyyy-zzzz",
 *         "reason": "not reachable: parser never sees untrusted XML",
 *         "expires": "2026-11-30" }
 *     ]
 *   }
 *
 * @param {unknown} manifest parsed root package.json
 * @param {string} today YYYY-MM-DD an entry is expired strictly before
 */
export function parseIgnoreRules(manifest, today) {
  if (!ISO_DATE.test(String(today))) {
    // Without a usable "today" nothing can expire, which would silently turn
    // every waiver permanent — the one outcome the expiry rule exists to stop.
    hardFail([`ignore expiry needs today as YYYY-MM-DD, got "${today}"`]);
  }
  const config =
    manifest && typeof manifest === "object" ? manifest.auditConfig : undefined;
  const entries =
    config && Array.isArray(config.ignoreCves) ? config.ignoreCves : [];
  const rules = [];
  const errors = [];
  entries.forEach((entry, index) => {
    const label = `auditConfig.ignoreCves[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label}: must be an object { id, reason, expires }.`);
      return;
    }
    const rawId = [entry.id, entry.cve, entry.ghsa].find(
      (candidate) => typeof candidate === "string" && candidate.trim() !== "",
    );
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    const expires =
      typeof entry.expires === "string" ? entry.expires.trim() : "";
    if (rawId === undefined) {
      errors.push(`${label}: needs "id" (a GHSA id or a CVE).`);
    }
    if (reason.length < MIN_REASON_LENGTH) {
      errors.push(
        `${label}: "reason" must be at least ${MIN_REASON_LENGTH} characters` +
          " explaining why this is safe to ship.",
      );
    }
    // Round-tripping through Date rejects impossible calendar dates such as
    // 2026-02-31, which a shape-only check would accept.
    const dateOk =
      ISO_DATE.test(expires) &&
      new Date(`${expires}T00:00:00Z`).toISOString().slice(0, 10) === expires;
    const expired = dateOk && expires < today;
    if (!dateOk) {
      errors.push(
        `${label}: "expires" must be a real calendar date as YYYY-MM-DD.`,
      );
    } else if (expired) {
      errors.push(
        `${label}: ignore for ${rawId ?? "?"} EXPIRED on ${expires} (today is ${today}).` +
          " Re-review it: fix the dependency or record a new expiry and reason.",
      );
    }
    // An expired rule is deliberately NOT added to `rules`, so it cannot
    // suppress anything: the finding it used to cover reappears as BLOCKING.
    // That is a second, independent reason for the run to fail, so a future
    // change to the config-error path cannot quietly resurrect a stale waiver.
    if (
      rawId !== undefined &&
      reason.length >= MIN_REASON_LENGTH &&
      dateOk &&
      !expired
    ) {
      rules.push({ id: rawId.trim().toUpperCase(), reason, expires });
    }
  });
  return { rules, errors };
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width
    ? `${text} `
    : text + " ".repeat(width - text.length);
}

function printSummary(buckets, level) {
  console.log("");
  console.log(`Reachability summary (blocking level: ${level} and above)`);
  console.log(
    `  ${pad("reachability", 34)}${pad("findings", 10)}${pad(`${level}+`, 8)}blocked`,
  );
  console.log(`  ${"-".repeat(58)}`);
  for (const reach of CLASS_ORDER) {
    const bucket = buckets.get(reach);
    const marker = BLOCKING_CLASSES.has(reach) ? "!" : " ";
    console.log(
      `${marker} ${pad(CLASS_LABEL.get(reach), 34)}${pad(bucket.all.length, 10)}` +
        `${pad(bucket.atLevel.length, 8)}${bucket.blocked.length}`,
    );
  }
  console.log(`  ${"-".repeat(58)}`);
  console.log("  (! = this class can fail the build)");
}

function printFindings(heading, records, explain) {
  if (records.length === 0) {
    return;
  }
  console.log("");
  console.log(heading);
  const sorted = [...records].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.moduleName.localeCompare(b.moduleName) ||
      a.label.localeCompare(b.label),
  );
  for (const record of sorted) {
    console.log(
      `  ${pad(record.severity, 9)}${pad(`${record.moduleName}@${record.version ?? "?"}`, 30)}` +
        `${pad(record.label, 24)}${record.path ?? "(no path reported)"}`,
    );
    if (explain) {
      console.log(`             why: ${record.why}`);
      console.log(`             ${record.title}`);
    }
    if (record.ignoredBy !== undefined) {
      console.log(
        `             ignored until ${record.ignoredBy.expires}: ${record.ignoredBy.reason}`,
      );
    }
  }
}
/**
 * The entire verdict with no I/O: parsed reports in, classified buckets and an
 * exit code out. Kept pure on purpose — this is the layer the unit tests drive
 * from fixtures, because "the gate quietly stopped failing" has no symptom.
 *
 * @param {object} input
 * @param {unknown} input.auditReport parsed `pnpm audit --json`
 * @param {unknown} input.workspaceListing parsed `pnpm list -r --depth=-1 --json`
 * @param {unknown} input.closureListing parsed `pnpm list --prod --depth=Infinity`
 * @param {unknown} input.manifest parsed root package.json (supplies auditConfig)
 * @param {string} [input.level] blocking severity threshold
 * @param {string} input.today YYYY-MM-DD an ignore entry is expired strictly before
 */
export function evaluateAdvisories({
  auditReport,
  workspaceListing,
  closureListing,
  manifest,
  level = DEFAULT_LEVEL,
  today,
}) {
  const records = normalizeAudit(auditReport);
  const packages = normalizeWorkspace(workspaceListing);
  const closure = productionClosure(normalizeClosureSource(closureListing));
  const tokens = new Map(packages.map((pkg) => [pkg.token, pkg]));
  const { rules, errors: configErrors } = parseIgnoreRules(manifest, today);
  const usedRuleIds = new Set();

  const threshold = severityRank(level);
  const buckets = new Map(
    CLASS_ORDER.map((reach) => [
      reach,
      { all: [], atLevel: [], blocked: [], ignored: [] },
    ]),
  );

  for (const record of records) {
    const { reach, why } = classify(record, closure, tokens);
    const classified = { ...record, reach, why };
    const bucket = buckets.get(reach);
    bucket.all.push(classified);
    if (severityRank(record.severity) < threshold) {
      continue;
    }
    bucket.atLevel.push(classified);
    if (!BLOCKING_CLASSES.has(reach)) {
      continue;
    }
    const rule = rules.find((candidate) => record.ids.has(candidate.id));
    if (rule === undefined) {
      bucket.blocked.push(classified);
    } else {
      usedRuleIds.add(rule.id);
      bucket.ignored.push({ ...classified, ignoredBy: rule });
    }
  }

  const blocked = CLASS_ORDER.flatMap((reach) => buckets.get(reach).blocked);
  const ignored = CLASS_ORDER.flatMap((reach) => buckets.get(reach).ignored);
  return {
    level,
    records,
    packages,
    closure,
    rules,
    staleRules: rules.filter((rule) => !usedRuleIds.has(rule.id)),
    buckets,
    blocked,
    ignored,
    configErrors,
    // A config error fails the run on its own: an unusable ignore list means the
    // suppression set is unknown, and an unknown suppression set cannot pass.
    exitCode: configErrors.length > 0 || blocked.length > 0 ? 1 : 0,
  };
}

function printReport(result) {
  const { level } = result;
  console.log("Advisory gate — reachability-classified pnpm audit");
  console.log(
    `  publishable packages : ${result.packages
      .filter((pkg) => pkg.publishable)
      .map((pkg) => pkg.name)
      .join(", ")}`,
  );
  console.log(
    `  production closure   : ${result.closure.size} resolved name@version pairs`,
  );
  console.log(`  advisory findings    : ${result.records.length}`);
  console.log(`  active ignores       : ${result.rules.length}`);

  printSummary(result.buckets, level);

  printFindings(
    `BLOCKING — ${level}+ reachable from a published package:`,
    result.blocked,
    true,
  );
  printFindings(
    "IGNORED — matched an unexpired auditConfig.ignoreCves entry:",
    result.ignored,
    true,
  );
  printFindings(
    "ADVISORY — build-time only (root devDependencies), does NOT fail the run:",
    result.buckets.get(DEV).atLevel,
    false,
  );
  printFindings(
    "ADVISORY — examples/* only (never published), does NOT fail the run:",
    result.buckets.get(EXAMPLE).atLevel,
    false,
  );

  if (result.staleRules.length > 0) {
    console.log("");
    console.log(
      "NOTE — ignore entries that matched nothing (candidates for deletion):",
    );
    for (const rule of result.staleRules) {
      console.log(`  ${pad(rule.id, 24)}expires ${rule.expires}`);
    }
  }

  if (result.configErrors.length > 0) {
    console.log("");
    console.log("✗ auditConfig.ignoreCves is not usable as written:");
    for (const error of result.configErrors) {
      console.log(`  - ${error}`);
    }
  }

  console.log("");
  if (result.blocked.length > 0) {
    console.log(
      `✗ ${result.blocked.length} ${level}+ advisory finding(s) reach a published package.`,
    );
    console.log(
      "  Fix by pinning a patched version (pnpm overrides / catalog), or record an",
    );
    console.log(
      "  auditConfig.ignoreCves entry with a written reason and an expiry date.",
    );
  }
  if (result.exitCode !== 0) {
    return;
  }

  console.log(`✓ No ${level}+ advisory reaches a published package.`);
  const advisoryCount =
    result.buckets.get(DEV).atLevel.length +
    result.buckets.get(EXAMPLE).atLevel.length;
  if (advisoryCount > 0) {
    console.log(
      `  ${advisoryCount} ${level}+ finding(s) remain in build-time/example trees —` +
        " reported above, not blocking.",
    );
  }
}

/** Gather every input (shelling out to pnpm unless overridden), then report. */
function main(argv) {
  const options = parseArgs(argv);
  const auditReport =
    options.auditJson === null
      ? runPnpmJson(["audit", "--json"], "advisory report")
      : readJsonFile(options.auditJson, "audit report");
  const workspaceListing =
    options.workspaceJson === null
      ? runPnpmJson(
          ["list", "--recursive", "--depth=-1", "--json"],
          "workspace package map",
        )
      : readJsonFile(options.workspaceJson, "workspace package map");
  const closureListing =
    options.closureJson === null
      ? runPnpmJson(
          [
            "list",
            "--prod",
            "--depth=Infinity",
            "--json",
            "--filter",
            `./${PUBLISHABLE_DIR}/*`,
          ],
          "publishable production closure",
        )
      : readJsonFile(options.closureJson, "publishable production closure");
  const manifest = readJsonFile(
    options.manifestJson ?? join(ROOT, "package.json"),
    "root package.json",
  );

  const result = evaluateAdvisories({
    auditReport,
    workspaceListing,
    closureListing,
    manifest,
    level: options.level,
    today: options.today,
  });
  printReport(result);
  return result.exitCode;
}

function runCli(argv) {
  try {
    return main(argv);
  } catch (error) {
    if (error instanceof AdvisoryGateError) {
      console.error(
        "\n✗ check-advisories cannot produce a trustworthy result:\n",
      );
      for (const line of error.lines) {
        console.error(`  ${line}`);
      }
      console.error("");
      return 2;
    }
    throw error;
  }
}

/**
 * True only when node was pointed at THIS file. `import`ing the module (the unit
 * test does) must not run the gate; `node scripts/check-advisories.mjs` must.
 * A misfire in the "not entry" direction would make all five CI call sites print
 * nothing and pass, so check-advisories.test.ts spawns the real CLI against
 * fixtures and asserts its exit code — a silent no-op fails there.
 */
function isProcessEntry() {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry === "") {
    return false;
  }
  const self = fileURLToPath(import.meta.url);
  if (resolve(entry) === self) {
    return true;
  }
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isProcessEntry()) {
  process.exit(runCli(process.argv.slice(2)));
}
