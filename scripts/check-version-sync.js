import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

// Belt-and-suspenders version-drift guard. Changesets `fixed` mode already keeps
// the three packages on one version, but a hand-edit, a bad merge, or a partial
// release could desync them. This asserts all published packages share one
// version, and — when run at a release tag (TAG env or argv) — that the tag
// matches that version. Dependency-free ESM, mirrors scripts/check-worker-sync.js.

const ROOT = resolve(import.meta.dirname, "..");

// The packages that publish to npm (private root excluded).
const PACKAGES = [
  "packages/bash",
  "packages/mcp-server",
  "packages/agent-bridge",
];

function readVersion(pkgDir) {
  const path = resolve(ROOT, pkgDir, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  return { name: pkg.name, version: pkg.version };
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

// Optional tag match: `--tag vX.Y.Z` or env TAG / GITHUB_REF_NAME. A leading
// `v` on the tag is tolerated. Only enforced when a tag is actually supplied.
const tagArgIndex = process.argv.indexOf("--tag");
const tag =
  (tagArgIndex !== -1 ? process.argv[tagArgIndex + 1] : undefined) ??
  process.env.TAG ??
  process.env.GITHUB_REF_NAME;

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
