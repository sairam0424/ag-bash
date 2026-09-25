# @ag-bash/bash

## 7.0.0

### Major Changes

- [#183](https://github.com/sairam0424/ag-bash/pull/183) [`3f378fb`](https://github.com/sairam0424/ag-bash/commit/3f378fb0f80d8746c8a28b3a56ba64a0d0387d51) Thanks [@sairam0424](https://github.com/sairam0424)! - **BREAKING: the default `destructivePolicy` is now `"block"` (was `"warn"`).**
  
  `destructivePolicy` was added in `6.0.0` with a default of `"warn"` — the AST-based
  destructive-command gate (`rm -rf /`, fork bombs, `dd`-to-device, `mkfs.*`,
  decode-pipe-to-shell, `$IFS`/command-substitution obfuscation) would attach a
  typed observation and a stderr warning line, but the command still executed.
  
  Any embedder that constructs `new Bash()` (or a `BashOptions` object) without an
  explicit `destructivePolicy` will now have destructive commands BLOCKED by
  default — the pipeline short-circuits with exit code `126` before the
  interpret stage ever runs, instead of warning and then executing. This closes
  the gap where the non-blocking default meant every consumer that hadn't
  explicitly opted into `"block"` was still one destructive command away from
  irreversible damage.
  
  Embedders that relied on the previous warn-and-continue behavior can restore
  it by passing `destructivePolicy: "warn"` (or `"allow"` to disable the gate
  entirely) to `new Bash(...)`. Per-call `ExecOptions.destructivePolicy`
  continues to override the instance default either way.

### Minor Changes

- [#172](https://github.com/sairam0424/ag-bash/pull/172) [`bd75357`](https://github.com/sairam0424/ag-bash/commit/bd75357a5d5d4734156f5682377044af12f33e35) Thanks [@sairam0424](https://github.com/sairam0424)! - Raise the minimum supported Node.js version from `>=20.6.0` to `>=22.12.0`. Node 20 reached end-of-life; Node 22 is the oldest currently-maintained line and already covered by this repo's own CI matrix. The `unit` CI job's ubuntu matrix drops Node 20 accordingly (now `[22, 24]`).

### Patch Changes

- [#177](https://github.com/sairam0424/ag-bash/pull/177) [`32fb7c9`](https://github.com/sairam0424/ag-bash/commit/32fb7c9ba6b6548f18f2d02e6953dd99c3fa829b) Thanks [@sairam0424](https://github.com/sairam0424)! - Upgrade `vitest`/`@vitest/coverage-v8` from 4.x to 5.0.2 (internal tooling only, no public API change). Does not adopt TypeScript 7.0 — a confirmed live bug (microsoft/TypeScript#63705) hits this repo's exact build shape (pnpm symlinked `node_modules` + `isolatedDeclarations`); staying on TypeScript 5.9.3 until that's resolved.

## 6.0.5

## 6.0.4

### Patch Changes

- [#100](https://github.com/sairam0424/ag-bash/pull/100) [`6bc4e0f`](https://github.com/sairam0424/ag-bash/commit/6bc4e0f976697009cb84ab7a9ad5d0da026b9cc6) Thanks [@sairam0424](https://github.com/sairam0424)! - Bug fixes (test-debt cleanup surfaced during the 6.0.3 release):

  - **find:** fix `-path` fast-path returning **zero results** on filesystems without
    `readdirWithFileTypes` — terminal-directory files (e.g. `find -path "*/pulls/*.json" -type f`)
    were never enqueued. (Data-loss-class correctness bug.)
  - **security:** enforce `maxFileDescriptors` for explicit numeric FDs (`exec N>file`, N>=3),
    which previously bypassed the limit entirely.
  - **agents:** add `CowFs` sync `mkdirSync`/`writeFileSync` so sub-agent spawn initializes its
    filesystem (spawn was broken under copy-on-write filesystems).
  - **pipeline:** hash/checksum filters (`md5sum`, `sha1sum`, `sha256sum`, …) now run on empty
    stdin instead of being short-circuited to empty output (`echo -n '' | md5sum`).

## 6.0.3

### Patch Changes

- [#90](https://github.com/sairam0424/ag-bash/pull/90) [`7df2593`](https://github.com/sairam0424/ag-bash/commit/7df2593c7c79147830e9f35b7163ef34e98cbaf7) Thanks [@sairam0424](https://github.com/sairam0424)! - Distribution & discoverability metadata.

  - `@ag-bash/bash`: add a keyword-rich `description`, 16 `keywords`, `homepage`, `bugs`, `funding`, and `repository.directory` for npm search discoverability.
  - `@ag-bash/mcp-server`: add `mcpName` (`io.github.sairam0424/ag-bash`) and a `server.json` for the official MCP Registry; add `homepage`/`bugs`.
  - `@ag-bash/agent-bridge`: clearer `description` plus `homepage`/`bugs`.

  No runtime/API changes — packaging metadata only.
