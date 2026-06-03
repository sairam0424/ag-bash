# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

This monorepo publishes its three packages — `@ag-bash/bash`,
`@ag-bash/mcp-server`, and `@ag-bash/agent-bridge` — at a **single synchronized
version** (`fixed` mode in `config.json`). A changeset that bumps any one of
them bumps all three together.

## Adding a changeset

```bash
pnpm changeset
```

Pick the bump type (patch/minor/major) and describe the change. Commit the
generated markdown file in this folder alongside your PR. On merge to `main`,
the release workflow (`.github/workflows/release.yml`) opens (or updates) a
"Version Packages" PR; merging that PR versions the packages, writes the
changelog, and publishes to npm via Trusted Publishing (OIDC).

`changeset publish` rewrites each package's `@ag-bash/bash: workspace:*`
dependency to the concrete published range — do not hand-publish with raw
`npm publish`, which skips that rewrite and ships an uninstallable package.
