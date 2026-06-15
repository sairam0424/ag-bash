---
"@ag-bash/bash": patch
---

Bug fixes (test-debt cleanup surfaced during the 6.0.3 release):

- **find:** fix `-path` fast-path returning **zero results** on filesystems without
  `readdirWithFileTypes` — terminal-directory files (e.g. `find -path "*/pulls/*.json" -type f`)
  were never enqueued. (Data-loss-class correctness bug.)
- **security:** enforce `maxFileDescriptors` for explicit numeric FDs (`exec N>file`, N>=3),
  which previously bypassed the limit entirely.
- **agents:** add `CowFs` sync `mkdirSync`/`writeFileSync` so sub-agent spawn initializes its
  filesystem (spawn was broken under copy-on-write filesystems).
- **pipeline:** hash/checksum filters (`md5sum`, `sha1sum`, `sha256sum`, …) now run on empty
  stdin instead of being short-circuited to empty output (`echo -n '' | md5sum`).
