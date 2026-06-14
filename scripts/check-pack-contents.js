import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

// Static, fast packaging gate. For each package it runs the REAL publish-tool
// pack (`pnpm pack`, which rewrites `workspace:*` to a concrete version the way
// `changeset publish`/`pnpm publish` do) and inspects the resulting tarball to
// assert (a) it contains the load-bearing runtime artifacts the build copies in,
// and (b) its packaged package.json carries no literal `workspace:` range.
//
// This guards the two packaging-defect classes that have shipped before:
//   - v6.0.0/6.0.1: leaked `workspace:*` (uninstallable) — caught by (b). It is
//     real ONLY because publishing via `npm publish` skips the rewrite; we pack
//     with pnpm here precisely to verify the rewrite the publish path relies on.
//   - v6.0.2: missing tree-sitter-bash.wasm (ENOENT at runtime) — caught by (a).
//
// It complements (does not replace) install-smoke.yml, which packs + installs +
// RUNS the artifacts. This check is the seconds-fast pre-filter.
//
// Dependency-free ESM, mirrors scripts/check-worker-sync.js. We inspect the
// source manifest only to read `workspace:` — the assertion is against the
// rewritten tarball manifest. Exits non-zero on the first failing package.

const ROOT = resolve(import.meta.dirname, "..");

// Per package: directory + substrings that MUST appear in the packed file list.
// These mirror the `cp` steps in packages/bash/package.json `build` and the
// esbuild outputs — every entry is a file a consumer needs at runtime.
const PACKAGES = [
  {
    name: "@ag-bash/bash",
    dir: "packages/bash",
    requiredFiles: [
      "dist/bundle/index.js",
      "dist/bundle/index.cjs",
      "dist/index.d.cts",
      "dist/parser/vendor/tree-sitter-bash.wasm",
      "dist/parser/vendor/web-tree-sitter.wasm",
      "dist/bundle/tree-sitter-bash.wasm",
      "dist/bin/chunks/python-worker.js",
      "dist/bin/chunks/js-worker.js",
      "dist/bin/chunks/sqlite-worker.js",
      "dist/bin/ag-bash.js",
      "dist/bin/shell/shell.js",
    ],
  },
  {
    name: "@ag-bash/mcp-server",
    dir: "packages/mcp-server",
    requiredFiles: ["dist/index.js"],
  },
  {
    name: "@ag-bash/agent-bridge",
    dir: "packages/agent-bridge",
    requiredFiles: ["dist/index.js", "dist/index.d.ts"],
  },
];

// Pack with pnpm into `destDir`; return the absolute path of the .tgz produced.
function pnpmPack(pkgDir, destDir) {
  const cwd = resolve(ROOT, pkgDir);
  const out = execFileSync("pnpm", ["pack", "--pack-destination", destDir], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // pnpm prints the tarball path on the last non-empty line.
  const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
  return line.startsWith("/") ? line : join(destDir, line);
}

// List paths inside the tarball (npm/pnpm tarballs root everything under package/).
function tarFileList(tgz) {
  const out = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ""));
}

// Extract package/package.json text from the tarball without unpacking to disk.
function tarManifest(tgz) {
  return execFileSync("tar", ["-xzO", "-f", tgz, "package/package.json"], {
    encoding: "utf8",
  });
}

function checkPackage(pkg, destDir) {
  const errors = [];
  let tgz;
  try {
    tgz = pnpmPack(pkg.dir, destDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`could not \`pnpm pack\` ${pkg.dir}: ${message}`];
  }

  // (a) Required runtime artifacts present in the packed file list.
  const files = tarFileList(tgz);
  for (const required of pkg.requiredFiles) {
    if (!files.includes(required)) {
      errors.push(`MISSING required file in tarball: ${required}`);
    }
  }

  // (b) The packed (rewritten) manifest must not leak a `workspace:` range.
  const manifest = tarManifest(tgz);
  if (manifest.includes("workspace:")) {
    errors.push(
      "packaged package.json still contains a literal `workspace:` range — " +
        "would publish uninstallable. The publish path MUST rewrite it " +
        "(use changeset publish / pnpm publish, never raw npm publish).",
    );
  }

  return errors;
}

const destDir = mkdtempSync(join(tmpdir(), "agbash-packcheck-"));
let failed = false;
try {
  for (const pkg of PACKAGES) {
    const errors = checkPackage(pkg, destDir);
    if (errors.length > 0) {
      failed = true;
      console.error(`[FAIL] ${pkg.name} (${pkg.dir}):`);
      for (const e of errors) {
        console.error(`  - ${e}`);
      }
    } else {
      console.log(`[ok]   ${pkg.name}: tarball contents + manifest verified`);
    }
  }
} finally {
  rmSync(destDir, { recursive: true, force: true });
}

if (failed) {
  console.error(
    "\nPack-contents check failed. Run `pnpm build` first; if a required file " +
      "moved, update scripts/check-pack-contents.js to match the build output.",
  );
  process.exit(1);
}
console.log("\nAll package tarballs contain their load-bearing artifacts.");
