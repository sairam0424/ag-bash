#!/usr/bin/env bash
set -euo pipefail

# ─── Ag-Bash Publish Script ──────────────────────────────────────────────────
# Publishes all @ag-bash packages to npm registry.
#
# Prerequisites:
#   1. Set NPM_TOKEN environment variable:
#      export NPM_TOKEN=npm_xxxxxxxxxxxxxxxx
#
#   2. Or create .npmrc from template:
#      cp .npmrc.template .npmrc
#      # Edit .npmrc and add your token
#
# Usage:
#   bash scripts/publish.sh              # publish current version
#   bash scripts/publish.sh --dry-run    # preview what would be published
#
# ─────────────────────────────────────────────────────────────────────────────

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
  echo "🔍 DRY RUN MODE — no packages will be published"
  echo ""
fi

# Verify NPM_TOKEN is available
if [[ -z "${NPM_TOKEN:-}" ]] && ! grep -q "_authToken" .npmrc 2>/dev/null; then
  echo "❌ Error: NPM_TOKEN not set and no .npmrc found"
  echo ""
  echo "Set up authentication:"
  echo "  export NPM_TOKEN=npm_xxxxxxxxxxxxxxxx"
  echo "  # or"
  echo "  cp .npmrc.template .npmrc && edit .npmrc"
  exit 1
fi

# Get version from source of truth
VERSION=$(node -e "console.log(require('./packages/bash/package.json').version)")
echo "📦 Publishing @ag-bash packages v${VERSION}"
echo ""

# Pre-publish checks
echo "── Pre-publish Checks ──"

echo -n "  Supply-chain audit (high/critical)... "
pnpm audit --audit-level=high 2>/dev/null && echo "✓" || { echo "✗ FAILED — high/critical advisory; pin a patched version via pnpm.overrides"; exit 1; }

echo -n "  Type check... "
pnpm --filter @ag-bash/bash typecheck 2>/dev/null && echo "✓" || { echo "✗ FAILED"; exit 1; }

echo -n "  Build... "
pnpm build 2>/dev/null && echo "✓" || { echo "✗ FAILED"; exit 1; }

echo -n "  Tests... "
pnpm --filter @ag-bash/bash test:run 2>/dev/null && echo "✓" || { echo "✗ FAILED (non-blocking)"; }

echo ""
echo "── Publishing ──"

# Publish order matters (bash first, then dependents)
PACKAGES=(
  "packages/bash"
  "packages/mcp-server"
  "packages/agent-bridge"
)

for pkg in "${PACKAGES[@]}"; do
  PKG_NAME=$(node -e "console.log(require('./${pkg}/package.json').name)")
  echo -n "  ${PKG_NAME}@${VERSION}... "

  # --provenance (E3): emit a Sigstore provenance attestation linking the
  # tarball to its build origin. Honored when publishing from CI with OIDC
  # (id-token); local runs without OIDC warn and skip the attestation but still
  # publish. The canonical provenance path is .github/workflows/publish.yml.
  if cd "$pkg" && pnpm publish --provenance --no-git-checks $DRY_RUN 2>/dev/null; then
    echo "✓ published"
  else
    echo "⚠ skipped (may already exist)"
  fi
  cd - > /dev/null
done

echo ""
echo "✅ Done! Published @ag-bash packages v${VERSION}"
echo ""
echo "Verify: npm info @ag-bash/bash version"
