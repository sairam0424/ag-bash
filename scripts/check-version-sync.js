import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

// Belt-and-suspenders version-drift guard. Changesets `fixed` mode already keeps
// the three packages on one version, but a hand-edit, a bad merge, or a partial
// release could desync them. This asserts all published packages share one
// version, and — when run at a release tag (TAG env or argv) — that the tag
// matches that version. Dependency-free ESM, mirrors scripts/check-worker-sync.js.
//
// The repo asserts its version in far more than the three manifests: a source
// literal in the engine, a wire-visible literal in the MCP handshake, a Docker
// build arg, three Homebrew formula assertions, two MCP-registry entries, and two
// Claude-Code plugin manifests. Those used to be unchecked, which is how
// `packages/bash/src/version.ts` and `packages/mcp-server/src/index.ts` sat at
// 6.0.2 and the Dockerfile at 6.0.3 while every package.json said 6.0.4. Every
// site below is now gated with an explicit extraction rule.

const ROOT = resolve(import.meta.dirname, "..");

// The packages that publish to npm (private root excluded). These package.json
// `version` fields are the source of truth every other site is compared against.
const PACKAGES = [
  "packages/bash",
  "packages/mcp-server",
  "packages/agent-bridge",
];

// Secondary assertion sites. Each has an explicit extraction rule:
//
//   `re`    — a global regex with exactly ONE capture group holding a version.
//             EVERY match must equal the manifest version.
//   `count` — how many matches the rule must find. A mismatch fails too: it means
//             an assertion was added, removed, or reworded and this rule went
//             stale, which would otherwise let the site pass vacuously.
//   `mode: "contains"` — prose docs. The file must mention the current version
//             somewhere. Deliberately loose: docs also cite historical versions
//             ("v6.0.0 introduced …"), so pinning an exact phrase would false-fail
//             on any rewording while still missing the real failure mode (bump the
//             packages, forget the docs).
const SITES = [
  {
    file: "packages/bash/src/version.ts",
    label: "engine VERSION literal (drives `ag-bash --version`)",
    re: /^export const VERSION = "([^"]+)";$/gm,
    count: 1,
  },
  {
    file: "packages/mcp-server/src/index.ts",
    label: "MCP serverInfo.version (wire-visible in the initialize handshake)",
    re: /^const SERVER_VERSION = "([^"]+)";$/gm,
    count: 1,
  },
  {
    file: "Dockerfile",
    label: "ARG AG_BASH_VERSION (npm pin baked into the catalog image)",
    re: /^ARG AG_BASH_VERSION=(\S+)$/gm,
    count: 1,
  },
  {
    file: "Dockerfile",
    label: "documented `docker build --build-arg` example",
    re: /--build-arg AG_BASH_VERSION=(\S+)/g,
    count: 1,
  },
  {
    file: "Formula/ag-bash.rb",
    label: "Homebrew tarball URLs (core + mcp-server)",
    re: /registry\.npmjs\.org\/@ag-bash\/[a-z-]+\/-\/[a-z-]+-(\d+\.\d+\.\d+)\.tgz/g,
    count: 2,
  },
  {
    file: "Formula/ag-bash.rb",
    label: "Homebrew `brew test` --version assertion",
    re: /assert_match "([^"]+)", shell_output/g,
    count: 1,
  },
  {
    file: "packages/mcp-server/server.json",
    label: "MCP registry server + npm package version",
    re: /^\s+"version": "([^"]+)"/gm,
    count: 2,
  },
  {
    file: ".claude-plugin/marketplace.json",
    label: "Claude Code marketplace plugin entry",
    re: /^\s+"version": "([^"]+)"/gm,
    count: 1,
  },
  {
    file: "plugins/ag-bash/.claude-plugin/plugin.json",
    label: "Claude Code plugin manifest",
    re: /^\s+"version": "([^"]+)"/gm,
    count: 1,
  },
  {
    file: "README.md",
    label: "README distribution baseline",
    mode: "contains",
  },
  {
    file: "packages/bash/README.md",
    label: "engine README distribution baseline",
    mode: "contains",
  },
  {
    file: "CLAUDE.md",
    label: "CLAUDE.md version baseline",
    mode: "contains",
  },
];

function readVersion(pkgDir) {
  const path = resolve(ROOT, pkgDir, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  return { name: pkg.name, version: pkg.version };
}

/** Returns `{ ok: true }` or `{ ok: false, reason }` for one secondary site. */
function checkSite(site, expected) {
  let text;
  try {
    text = readFileSync(resolve(ROOT, site.file), "utf8");
  } catch {
    return {
      ok: false,
      reason: "file is missing — the extraction rule is stale",
    };
  }

  if (site.mode === "contains") {
    return text.includes(expected)
      ? { ok: true }
      : { ok: false, reason: `does not mention v${expected} anywhere` };
  }

  const found = [...text.matchAll(site.re)].map((m) => m[1]);
  if (found.length !== site.count) {
    return {
      ok: false,
      reason:
        `matched ${found.length} version assertion(s), expected ${site.count} — ` +
        "the extraction rule in scripts/check-version-sync.js is stale",
    };
  }
  const wrong = [...new Set(found.filter((v) => v !== expected))];
  if (wrong.length > 0) {
    return {
      ok: false,
      reason: `says ${wrong.join(", ")}, expected ${expected}`,
    };
  }
  return { ok: true };
}

const versions = PACKAGES.map(readVersion);
const unique = [...new Set(versions.map((v) => v.version))];

let failed = false;

if (unique.length !== 1) {
  failed = true;
  console.error("[FAIL] package versions are not synchronized:");
  for (const v of versions) {
    console.error(`  - ${v.name}: ${v.version}`);
  }
  console.error(
    "All three packages publish at one synchronized version (Changesets " +
      "`fixed` mode). Re-run `pnpm version-packages` or fix the drift by hand.",
  );
} else {
  console.log(`[ok]   all packages at v${unique[0]}`);
}

// Secondary sites are only checkable once the manifests agree on one version —
// otherwise there is no unambiguous value to compare against.
if (unique.length === 1) {
  const expected = unique[0];
  const drifted = [];

  for (const site of SITES) {
    const result = checkSite(site, expected);
    if (!result.ok) {
      drifted.push({ site, reason: result.reason });
    }
  }

  if (drifted.length > 0) {
    failed = true;
    console.error(
      `[FAIL] ${drifted.length} of ${SITES.length} secondary version sites drifted from v${expected}:`,
    );
    for (const { site, reason } of drifted) {
      console.error(`  - ${site.file}: ${site.label} — ${reason}`);
    }
    console.error(
      "Every site above ships the version to a user (CLI output, MCP handshake, " +
        "Homebrew, Docker, plugin manifests). Update them to " +
        `${expected} — or, if a site was intentionally reworded, update its ` +
        "extraction rule in scripts/check-version-sync.js.",
    );
  } else {
    console.log(
      `[ok]   all ${SITES.length} secondary version sites at v${expected}`,
    );
  }
}

// Optional tag match: `--tag vX.Y.Z` or env TAG / GITHUB_REF_NAME. A leading
// `v` on the tag is tolerated. Only enforced when a tag is actually supplied.
//
// GITHUB_REF_NAME is set for BOTH branches and tags, so only treat it as a release
// tag when GITHUB_REF_TYPE === "tag". Otherwise a push-to-main release (Changesets
// flow, ref_type=branch, ref_name="main") would compare "main" against the semver and
// always fail. Explicit `--tag`/`TAG` still take precedence for manual/tag releases.
const tagArgIndex = process.argv.indexOf("--tag");
const refNameTag =
  process.env.GITHUB_REF_TYPE === "tag"
    ? process.env.GITHUB_REF_NAME
    : undefined;
const tag =
  (tagArgIndex !== -1 ? process.argv[tagArgIndex + 1] : undefined) ??
  process.env.TAG ??
  refNameTag;

if (tag) {
  const normalized = tag.replace(/^v/, "");
  if (!failed && normalized !== unique[0]) {
    failed = true;
    console.error(
      `[FAIL] release tag ${tag} does not match package version ${unique[0]}.`,
    );
  } else if (!failed) {
    console.log(`[ok]   release tag ${tag} matches package version`);
  }
}

if (failed) {
  process.exit(1);
}
