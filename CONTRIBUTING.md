# Contributing to Ag-Bash

Ag-Bash is a security-critical, sandboxed bash interpreter. Contributions are
welcome — this guide covers the workflow, the CI gates, and the one piece of
repo configuration the maintainer must keep in sync.

## Quick start

```bash
pnpm install
pnpm build
pnpm --filter @ag-bash/bash validate   # full local gate: lint + knip + typecheck + build + worker-sync + tests
```

## Commit & PR conventions

- **Conventional commits**: `type(scope): description`. Allowed types:
  `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `style`, `chore`, `ci`,
  `release`. Scopes are open (e.g. `parser`, `security`, `wasm`, `cli`, `mcp`).
  Breaking changes append `!` (e.g. `feat(core)!: …`). PR titles are linted by
  `pr-title-lint.yml`; since the repo squash-merges, the PR title becomes the
  commit message.
- **Changesets**: any user-facing change to a published package needs a
  changeset — run `pnpm changeset`, pick the bump, commit the generated file.
  The three packages are versioned together (Changesets `fixed` mode). CI/docs-
  only PRs need none.
- **Security impact**: the PR template has a mandatory Security Impact section.
  Fill it honestly — "none" is fine, but must be deliberate.

## CI gates (what runs on your PR)

| Workflow | Gate |
|----------|------|
| `quality.yml` | biome + banned-patterns + knip + typecheck + build + worker-sync + version/pack checks |
| `tests.yml` | build-once → unit (Node 20/22/24) + wasm + comparison + mcp + coverage; **`gate` job aggregates them** |
| `codeql.yml` | SAST (javascript-typescript + actions) |
| `dependency-review.yml` | blocks PRs adding a HIGH+ advisory dependency |
| `install-smoke.yml` | packs + clean-room installs the tarballs and runs the bins/MCP handshake |
| `bundle-size.yml` | browser bundle Brotli budget |
| `examples.yml` | publint + attw + example typechecks (some non-blocking; see below) |

Some `examples.yml` checks (publint, attw, the `bash-agent`/`cjs-consumer`
typechecks) are intentionally **non-blocking** today — they surface documented
pre-existing export-map / SDK-drift issues without failing CI red. Do not rely
on them to block; do read their output.

## Maintainer: branch ruleset & required checks (GOV-5)

The CI gates above are only *enforced* if branch protection requires them.
Configure a ruleset on `main` and `develop` that requires:

- **`gate`** — the single aggregator job in `tests.yml`. **Require THIS, not the
  individual matrix legs.** Matrix-leg names (e.g. `unit (ubuntu-latest, 22)`)
  change when the matrix changes, and `paths-ignore` skips would leave a
  required leg "pending" forever — wedging merges. The `gate` job always runs
  (`if: always()`) and reports pass/fail for the whole suite, so it is the
  stable required context.
- `quality`, `CodeQL`, and `smoke` (install-smoke) as additional required checks.
- 1 approving review; block force-push and branch deletion.

Start the ruleset in **`evaluate`** mode, confirm the contexts report, then flip
to **`active`**. `dependabot-auto-merge.yml` is INERT until required checks are
active (it only enqueues `--auto`, which waits on them).

> If you rename a CI job, update this list and the ruleset together — a renamed
> required context silently stops gating.

## Reporting security issues

Do **not** open a public issue. See [SECURITY.md](./SECURITY.md) for private
disclosure.
