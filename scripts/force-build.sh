#!/bin/bash
#
# Force-rebuild every package in the monorepo.
#
# This is a thin wrapper over `pnpm -r build` ON PURPOSE. Every package's own
# `build` script already begins with `rm -rf dist`, so a recursive build IS a
# force build — there is nothing for this script to add.
#
# It used to reimplement the build inline, and had drifted badly: last touched at
# v1.3.0 (against a 6.0.4 tree) it was missing EIGHT steps that
# packages/bash's `build` performs, including `cp src/parser/vendor/*
# dist/parser/vendor/`. Because it also starts by deleting dist, that omission
# made it unconditionally broken from any starting state:
#
#   ✘ [ERROR] Could not resolve "./vendor/web-tree-sitter.js"
#       dist/parser/tree-sitter-parser.js:2:28
#
# It also omitted the ag-convert Python asset copy, the sqlite3 worker, the CJS
# subpaths, browser-core, build:clean, and the .d.cts generation — and it wrote
# the python3/js-exec worker bundles into src/ rather than dist/.
#
# Keep this a delegation. If the build needs a new step, add it to the relevant
# package's `build` script, which is the single source of truth.
#
# Scoped to packages/* rather than a bare `pnpm -r build`: the workspace also
# includes examples/*, which is pinned to a Next.js canary and is therefore
# inherently unstable. A force build of the shipped packages must not fail
# because an example did.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "🚀 Force-rebuilding packages/* (each package's build cleans its own dist)..."
pnpm --filter "./packages/*" build
echo "✅ Monorepo force build complete."
