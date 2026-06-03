<!--
  Ag-Bash is a security-critical sandboxed bash interpreter. The Security Impact
  section below is MANDATORY — reviewers use it to decide depth of review.
-->

## Summary

<!-- What does this PR do, and why? 1–3 sentences. -->

## Affected package(s)

- [ ] `@ag-bash/bash` (core engine)
- [ ] `@ag-bash/mcp-server`
- [ ] `@ag-bash/agent-bridge`
- [ ] CI / tooling / docs only

## Security Impact (required)

> Ag-Bash's entire value is a hardened trust boundary. Answer honestly — "no"
> is a fine answer, but it must be a deliberate one.

- [ ] Touches the **sandbox / defense-in-depth** (`packages/bash/src/security/**`, AsyncLocalStorage box, `eval`/`Function`/`process.*` blocking)
- [ ] Touches a **WASM runtime** or worker bridge (python3 / sqlite3 / js-exec)
- [ ] Touches **filesystem access** (must go through `resolveAndValidate()`)
- [ ] Adds/changes a **banned-pattern** rule or uses `// @banned-pattern-ignore`
- [ ] Touches the **publish path** (`release.yml`, `.changeset/`, `package.json` `exports`/`files`/`bin`)
- [ ] Adds or upgrades a **dependency** (incl. a SHA-pinned GitHub Action)
- [ ] **None of the above** — no security-relevant surface changed

If any box above is checked, describe the impact and how it's mitigated:

<!-- e.g. "Adds a new builtin; all FS access routed through resolveAndValidate; no new globals exposed in the sandbox." -->

## Test plan

<!-- Mirror `pnpm --filter @ag-bash/bash validate` where relevant. -->

- [ ] `pnpm lint` + `pnpm typecheck` pass
- [ ] `pnpm --filter @ag-bash/bash test:unit` (+ `test:wasm` if WASM touched)
- [ ] Added/updated tests for the change (bug fixes include a regression test)
- [ ] For packaging/publish changes: `pnpm check:pack-contents` + install-smoke considered

## Changeset

- [ ] Ran `pnpm changeset` (required for any user-facing change to a published package), or this PR is CI/docs-only and needs no version bump.
