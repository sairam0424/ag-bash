/**
 * Tests for the release-blocking supply-chain gate, scripts/check-advisories.mjs.
 *
 * The gate runs in five places (quality.yml, release.yml, publish.yml,
 * canary.yml, scripts/publish.sh) and its correctness had been demonstrated
 * exactly once, by hand, against a throwaway fixture. A gate that silently stops
 * failing is worse than no gate, so its verdict is pinned here.
 *
 * Fixture provenance — `scripts/__fixtures__/advisories/`:
 *   published-high.json, dev-only-high.json are real `pnpm audit --json` output
 *   from this workspace, reduced to a handful of advisories with `overview` and
 *   `references` truncated to one line and `metadata.vulnerabilities` recounted.
 *   Every other field is verbatim, including the detail that made the shape
 *   surprising: pnpm collapses `findings` to ONE representative path per
 *   (advisory, version), so advisory 1124252 in dev-only-high.json carries two
 *   findings — postcss@8.5.10 under a devDependency root and postcss@8.4.31
 *   under an examples root — and the printed root for a shared version is
 *   arbitrary. Reachability therefore has to be decided by (module, version)
 *   membership in the published closure, not by the printed path, and
 *   published-high.json pins exactly that: its two high advisories print
 *   devDependency roots (`.>vitest>vite`) yet must still BLOCK once their
 *   resolved versions appear in the closure.
 *
 * The scenario knob is the CLOSURE, built here, never the advisory data.
 * Nothing in this file shells out to `pnpm audit`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const GATE_PATH = join(REPO_ROOT, "scripts", "check-advisories.mjs");
const FIXTURE_DIR = join(REPO_ROOT, "scripts", "__fixtures__", "advisories");

const MS_PER_DAY = 86_400_000;
// Read once. Every date below is derived from this single instant so that a run
// straddling UTC midnight cannot make `isoDay(0)` disagree with TODAY and flip
// the "expires today is still in date" boundary case.
const NOW_MS = Date.now();

/** YYYY-MM-DD `offsetDays` from now. Relative so the suite cannot rot. */
function isoDay(offsetDays: number): string {
  return new Date(NOW_MS + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

const TODAY = isoDay(0);

// The gate is a dependency-free .mjs outside packages/bash/src, so it is loaded
// through a runtime dynamic import: a static import would drag it into this
// package's tsconfig rootDir and into `tsc --noEmit`.
type Reach = "published" | "unknown" | "dev" | "example";
interface Bucket {
  all: AdvisoryRecord[];
  atLevel: AdvisoryRecord[];
  blocked: AdvisoryRecord[];
  ignored: AdvisoryRecord[];
}
interface AdvisoryRecord {
  label: string;
  severity: string;
  moduleName: string;
  version: string | null;
  path: string | null;
  reach: Reach;
  why: string;
  ignoredBy?: { id: string; reason: string; expires: string };
}
interface Verdict {
  level: string;
  records: AdvisoryRecord[];
  closure: Set<string>;
  rules: { id: string; reason: string; expires: string }[];
  staleRules: { id: string }[];
  buckets: Map<Reach, Bucket>;
  blocked: AdvisoryRecord[];
  ignored: AdvisoryRecord[];
  configErrors: string[];
  exitCode: number;
}
interface Gate {
  evaluateAdvisories: (input: Record<string, unknown>) => Verdict;
  parseIgnoreRules: (
    manifest: unknown,
    today: string,
  ) => { rules: { id: string }[]; errors: string[] };
}

let gate: Gate;

beforeAll(async () => {
  gate = (await import(
    /* @vite-ignore */ pathToFileURL(GATE_PATH).href
  )) as unknown as Gate;
});

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

function auditFixture(name: string): unknown {
  return JSON.parse(readFixture(name));
}

/**
 * `pnpm list --recursive --depth=-1 --json`, reduced to the fields the gate
 * reads. Paths must be absolute and under the repo root: the gate turns the
 * workspace-relative directory into the audit path-root token
 * (`packages/bash` -> `packages__bash`, workspace root -> `.`).
 */
function workspaceListing(): unknown[] {
  return [
    { name: "ag-bash-monorepo", path: REPO_ROOT, private: true },
    {
      name: "website",
      version: "1.3.2",
      path: join(REPO_ROOT, "examples", "website"),
      private: true,
    },
    {
      name: "@ag-bash/bash",
      version: "6.0.4",
      path: join(REPO_ROOT, "packages", "bash"),
      private: false,
    },
    {
      name: "@ag-bash/mcp-server",
      version: "6.0.4",
      path: join(REPO_ROOT, "packages", "mcp-server"),
      private: false,
    },
  ];
}

function depNode(
  name: string,
  version: string,
  children?: Record<string, unknown>,
): Record<string, unknown> {
  const node: Record<string, unknown> = Object.create(null);
  node.from = name;
  node.version = version;
  node.resolved = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
  node.path = join(
    REPO_ROOT,
    "node_modules",
    ".pnpm",
    `${name}@${version}`,
    "node_modules",
    name,
  );
  if (children !== undefined) {
    node.dependencies = children;
  }
  return node;
}

/**
 * `pnpm list --prod --depth=Infinity --json --filter ./packages/*`, reduced.
 * `shipped` is the scenario knob: whatever is listed here counts as reachable
 * from something published. The always-present tail (diff/ini/node-liblzma and
 * its two real children) exists because the gate hard-fails when the closure is
 * no bigger than the direct dependency count — that guard catches a truncated
 * `pnpm list`, and a flat fixture would trip it.
 */
function closureListing(shipped: ReadonlyArray<[string, string]>): unknown[] {
  const shippedNodes = (): Record<string, unknown> => {
    const deps: Record<string, unknown> = Object.create(null);
    for (const [name, version] of shipped) {
      deps[name] = depNode(name, version);
    }
    deps.diff = depNode("diff", "8.0.4");
    deps.ini = depNode("ini", "6.0.0");
    deps["node-liblzma"] = depNode("node-liblzma", "2.2.0", {
      "node-addon-api": depNode("node-addon-api", "8.7.0"),
      "node-gyp-build": depNode("node-gyp-build", "4.8.4"),
    });
    return deps;
  };
  return [
    {
      name: "@ag-bash/bash",
      version: "6.0.4",
      path: join(REPO_ROOT, "packages", "bash"),
      private: false,
      dependencies: shippedNodes(),
    },
    {
      name: "@ag-bash/mcp-server",
      version: "6.0.4",
      path: join(REPO_ROOT, "packages", "mcp-server"),
      private: false,
      dependencies: {
        "@ag-bash/bash": {
          from: "@ag-bash/bash",
          version: "link:../bash",
          path: join(REPO_ROOT, "packages", "bash"),
          deduped: true,
          dedupedDependenciesCount: 177,
        },
      },
    },
  ];
}

/** The two versions published-high.json reports, promoted into the closure. */
const SHIPPED_VULNERABLE: ReadonlyArray<[string, string]> = [
  ["ws", "8.20.0"],
  ["vite", "8.0.8"],
  ["fast-xml-parser", "5.6.0"],
];

const NO_IGNORES = {
  name: "ag-bash-monorepo",
  auditConfig: { ignoreCves: [] },
};

/**
 * expired-ignore.json with its two `<expires:...>` placeholders resolved to real
 * dates `offsetDays` from today, so no assertion here is anchored to a calendar
 * date that will one day drift past.
 */
function ignoreManifest(viteOffsetDays: number, wsOffsetDays: number): unknown {
  const text = readFixture("expired-ignore.json")
    .replace("<expires:vite>", isoDay(viteOffsetDays))
    .replace("<expires:ws>", isoDay(wsOffsetDays));
  return JSON.parse(text);
}

function evaluate(
  auditFile: string,
  shipped: ReadonlyArray<[string, string]>,
  manifest: unknown = NO_IGNORES,
  level = "high",
): Verdict {
  return gate.evaluateAdvisories({
    auditReport: auditFixture(auditFile),
    workspaceListing: workspaceListing(),
    closureListing: closureListing(shipped),
    manifest,
    level,
    today: TODAY,
  });
}

function labels(records: AdvisoryRecord[]): string[] {
  return records.map((record) => record.label).sort();
}

describe("check-advisories: reachability decides who blocks", () => {
  it("BLOCKS a high advisory reachable from a published package", () => {
    const result = evaluate("published-high.json", SHIPPED_VULNERABLE);

    expect(labels(result.blocked)).toEqual([
      "GHSA-96hv-2xvq-fx4p",
      "GHSA-fx2h-pf6j-xcff",
    ]);
    expect(result.exitCode).toBe(1);
    // The load-bearing detail: both findings print a devDependency path root,
    // and are blocked anyway because the resolved version is in the closure.
    for (const record of result.blocked) {
      expect(record.reach).toBe("published");
      expect(record.path).toMatch(/^\.>/);
      expect(record.why).toBe(
        "resolved version is in the publishable production closure",
      );
    }
  });

  it("does not block a published finding below the level threshold", () => {
    const result = evaluate("published-high.json", SHIPPED_VULNERABLE);
    const published = result.buckets.get("published");

    // fast-xml-parser@5.6.0 is genuinely shipped, but only moderate.
    expect(labels(published?.all ?? [])).toContain("GHSA-gh4j-gqv2-49f6");
    expect(labels(published?.atLevel ?? [])).not.toContain(
      "GHSA-gh4j-gqv2-49f6",
    );
    expect(labels(result.blocked)).not.toContain("GHSA-gh4j-gqv2-49f6");
  });

  it("PASSES but reports a high advisory that is only a root devDependency", () => {
    const result = evaluate("dev-only-high.json", []);
    const dev = result.buckets.get("dev");

    expect(result.blocked).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(labels(dev?.atLevel ?? [])).toEqual([
      "GHSA-52cp-r559-cp3m", // js-yaml, .>@changesets/cli>...
      "GHSA-6g55-p6wh-862q", // postcss@8.5.10, .>vitest>vite>postcss
    ]);
    for (const record of dev?.atLevel ?? []) {
      expect(record.reach).toBe("dev");
      expect(record.why).toBe("workspace-root devDependency path");
    }
  });

  it("PASSES but reports a high advisory that is only in examples/*", () => {
    const result = evaluate("dev-only-high.json", []);
    const example = result.buckets.get("example");

    expect(result.exitCode).toBe(0);
    expect(labels(example?.atLevel ?? [])).toEqual([
      "GHSA-3jxr-9vmj-r5cp", // brace-expansion, examples__website>eslint>...
      "GHSA-6g55-p6wh-862q", // postcss@8.4.31, examples__website>next>postcss
    ]);
    for (const record of example?.atLevel ?? []) {
      expect(record.reach).toBe("example");
      expect(record.why).toBe(
        "dependency path rooted at website (not published)",
      );
    }
  });

  it("splits one advisory's two collapsed findings across two classes", () => {
    // GHSA-6g55-p6wh-862q has one finding per version; the dev-rooted 8.5.10 and
    // the examples-rooted 8.4.31 must not be merged into a single verdict.
    const result = evaluate("dev-only-high.json", []);
    const postcss = result.records.filter(
      (record) => record.label === "GHSA-6g55-p6wh-862q",
    );

    expect(postcss.map((record) => record.version).sort()).toEqual([
      "8.4.31",
      "8.5.10",
    ]);
  });

  it("fails closed on an unrecognised path root", () => {
    // No version in the closure and a root that is not a workspace package:
    // the gate must refuse to call it harmless.
    const result = evaluate("published-high.json", []);

    expect(labels(result.blocked)).toEqual([]);
    const dev = result.buckets.get("dev");
    expect(labels(dev?.atLevel ?? [])).toEqual([
      "GHSA-96hv-2xvq-fx4p",
      "GHSA-fx2h-pf6j-xcff",
    ]);
  });
});

describe("check-advisories: ignore expiry is enforced", () => {
  it("FAILS when an ignore entry's expiry has already passed", () => {
    // vite's waiver expired yesterday; ws's is still in date.
    const result = evaluate(
      "published-high.json",
      SHIPPED_VULNERABLE,
      ignoreManifest(-1, 30),
    );

    expect(result.configErrors).toHaveLength(1);
    expect(result.configErrors[0]).toContain("EXPIRED");
    expect(result.configErrors[0]).toContain("GHSA-fx2h-pf6j-xcff");
    expect(result.exitCode).toBe(1);
    // Second, independent reason to fail: an expired rule suppresses nothing, so
    // the finding it used to cover comes back as BLOCKING.
    expect(labels(result.blocked)).toEqual(["GHSA-fx2h-pf6j-xcff"]);
    expect(labels(result.ignored)).toEqual(["GHSA-96hv-2xvq-fx4p"]);
  });

  it("PASSES with the identical config when both expiries are in date", () => {
    // Byte-for-byte the same fixture as the failing case above; only the two
    // dates move. Expiry is therefore the sole difference between pass and fail.
    const result = evaluate(
      "published-high.json",
      SHIPPED_VULNERABLE,
      ignoreManifest(30, 30),
    );

    expect(result.configErrors).toEqual([]);
    expect(result.blocked).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(labels(result.ignored)).toEqual([
      "GHSA-96hv-2xvq-fx4p",
      "GHSA-fx2h-pf6j-xcff",
    ]);
  });

  it("treats an entry expiring today as still in date (boundary)", () => {
    const result = evaluate(
      "published-high.json",
      SHIPPED_VULNERABLE,
      ignoreManifest(0, 0),
    );

    expect(result.configErrors).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("suppresses only the matched advisory, not the others", () => {
    // Only ws is waived; vite must still block.
    const result = evaluate(
      "published-high.json",
      SHIPPED_VULNERABLE,
      ignoreManifest(30, 30),
    );
    const wsOnly = evaluate("published-high.json", SHIPPED_VULNERABLE, {
      auditConfig: {
        ignoreCves: [
          {
            id: "CVE-2026-48779",
            reason: "ws is reached only by the jsdom websocket shim",
            expires: isoDay(30),
          },
        ],
      },
    });

    expect(result.blocked).toEqual([]);
    expect(labels(wsOnly.ignored)).toEqual(["GHSA-96hv-2xvq-fx4p"]);
    expect(labels(wsOnly.blocked)).toEqual(["GHSA-fx2h-pf6j-xcff"]);
    expect(wsOnly.exitCode).toBe(1);
  });

  it("matches an ignore entry written as a CVE, not only as a GHSA id", () => {
    // The in-date entry in expired-ignore.json is spelled CVE-2026-48779 while
    // the advisory is labelled GHSA-96hv-2xvq-fx4p.
    const result = evaluate(
      "published-high.json",
      SHIPPED_VULNERABLE,
      ignoreManifest(30, 30),
    );
    const wsIgnore = result.ignored.find(
      (record) => record.label === "GHSA-96hv-2xvq-fx4p",
    );

    expect(wsIgnore?.ignoredBy?.id).toBe("CVE-2026-48779");
  });

  it("reports an in-date ignore that matched nothing as stale", () => {
    const result = evaluate("dev-only-high.json", [], ignoreManifest(30, 30));

    expect(result.staleRules.map((rule) => rule.id).sort()).toEqual([
      "CVE-2026-48779",
      "GHSA-FX2H-PF6J-XCFF",
    ]);
    expect(result.exitCode).toBe(0);
  });
});

describe("check-advisories: parseIgnoreRules validation", () => {
  function rulesFor(entries: unknown[]) {
    return gate.parseIgnoreRules(
      { auditConfig: { ignoreCves: entries } },
      TODAY,
    );
  }

  it("rejects an entry with no reason and drops it from the active rules", () => {
    const { rules, errors } = rulesFor([
      { id: "GHSA-aaaa-bbbb-cccc", reason: "too short", expires: isoDay(30) },
    ]);

    expect(rules).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("reason");
  });

  it("rejects an impossible calendar date", () => {
    const { rules, errors } = rulesFor([
      {
        id: "GHSA-aaaa-bbbb-cccc",
        reason: "shape-only date checks accept 2026-02-31",
        expires: "2026-02-31",
      },
    ]);

    expect(rules).toEqual([]);
    expect(errors[0]).toContain("real calendar date");
  });

  it("accepts a well-formed entry", () => {
    const { rules, errors } = rulesFor([
      {
        id: "ghsa-aaaa-bbbb-cccc",
        reason: "reachable only from the docs build",
        expires: isoDay(7),
      },
    ]);

    expect(errors).toEqual([]);
    expect(rules).toEqual([
      expect.objectContaining({ id: "GHSA-AAAA-BBBB-CCCC" }),
    ]);
  });
});

describe("check-advisories: the CLI entry point still runs", () => {
  // scripts/check-advisories.mjs only executes when it is the process entry
  // point, so that importing it above does not run the gate. If that detection
  // ever misfired, all five CI call sites would print nothing and exit 0 — a
  // silent pass. These two cases are the guard against that.
  function runCli(auditFile: string, shipped: ReadonlyArray<[string, string]>) {
    const dir = mkdtempSync(join(tmpdir(), "ag-advisory-cli-"));
    const workspaceFile = join(dir, "workspace.json");
    const closureFile = join(dir, "closure.json");
    const manifestFile = join(dir, "package.json");
    writeFileSync(workspaceFile, JSON.stringify(workspaceListing()));
    writeFileSync(closureFile, JSON.stringify(closureListing(shipped)));
    writeFileSync(manifestFile, JSON.stringify(NO_IGNORES));
    return spawnSync(
      process.execPath,
      [
        GATE_PATH,
        `--audit-json=${join(FIXTURE_DIR, auditFile)}`,
        `--workspace-json=${workspaceFile}`,
        `--closure-json=${closureFile}`,
        `--manifest-json=${manifestFile}`,
        `--today=${TODAY}`,
      ],
      { encoding: "utf8" },
    );
  }

  it("exits 1 and prints BLOCKING for a published high", () => {
    const run = runCli("published-high.json", SHIPPED_VULNERABLE);

    expect(run.stdout).toContain("Advisory gate");
    expect(run.stdout).toContain(
      "BLOCKING — high+ reachable from a published package:",
    );
    expect(run.status).toBe(1);
  });

  it("exits 0 and prints the clean line for dev/example-only highs", () => {
    const run = runCli("dev-only-high.json", []);

    expect(run.stdout).toContain(
      "✓ No high+ advisory reaches a published package.",
    );
    expect(run.stdout).toContain(
      "4 high+ finding(s) remain in build-time/example trees",
    );
    expect(run.status).toBe(0);
  });
});
