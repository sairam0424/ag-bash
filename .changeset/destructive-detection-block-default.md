---
"@ag-bash/bash": major
"@ag-bash/mcp-server": major
"@ag-bash/agent-bridge": major
---

**BREAKING: the default `destructivePolicy` is now `"block"` (was `"warn"`).**

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
