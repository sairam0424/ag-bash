# @ag-bash/bash

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
