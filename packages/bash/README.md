# @ag-bash/bash

> AI-Native Sandboxed Bash Runtime for TypeScript

[![npm version](https://img.shields.io/npm/v/@ag-bash/bash?label=npm&color=cb3837)](https://www.npmjs.com/package/@ag-bash/bash)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A complete bash interpreter with an in-memory filesystem, built for AI agents and TypeScript applications. No VM, no Docker, no native dependencies.

> Part of the Ag-Bash suite — also available as an MCP server (`@ag-bash/mcp-server`) and a Claude Code plugin.

## Quick Start

```bash
npm i @ag-bash/bash
```

### Direct execution

```typescript
import { Bash } from "@ag-bash/bash";

const bash = new Bash();
const result = await bash.exec("echo hello");
console.log(result.stdout); // "hello\n"
```

### Tagged template (zx-style)

```typescript
import { createShell } from "@ag-bash/bash";

const $ = createShell();
const name = "world";
const result = await $`echo ${name}`;
console.log(result.stdout); // "world\n"
```

Interpolated values are escaped with `shellEscape()`, so untrusted input cannot break out of the command.

### Incremental streaming

`execStream()` is an AsyncGenerator that yields output as it is produced, instead of buffering until the script finishes.

```typescript
import { Bash } from "@ag-bash/bash";

const bash = new Bash();
for await (const chunk of bash.execStream("echo one; echo two")) {
  if (chunk.type === "stdout") {
    console.log(chunk.data); // "one\n" then "two\n"
  }
}
```

### Branching execution

`fork()` returns a fully isolated copy of the sandbox. Writes inside the branch — including filesystem writes — are invisible to the parent, which makes it cheap to try a candidate command sequence and throw it away.

```typescript
import { Bash } from "@ag-bash/bash";

const bash = new Bash({ files: { "/notes.txt": "draft\n" } });

const branch = await bash.fork();
await branch.exec("echo experiment >> /notes.txt");

const parent = await bash.exec("cat /notes.txt");
console.log(parent.stdout); // still "draft\n"
```

Use `bash.speculate([...])` to run several branches concurrently and score the results.

### Custom commands

```typescript
import { Bash, defineCommand } from "@ag-bash/bash";

const greet = defineCommand("greet", async (args) => ({
  stdout: `Hello, ${args[0] ?? "world"}!\n`,
  stderr: "",
  exitCode: 0,
}));

const bash = new Bash({ customCommands: [greet] });
const result = await bash.exec("greet Alice | tr a-z A-Z");
console.log(result.stdout); // "HELLO, ALICE!\n"
```

Custom commands participate in pipes, redirections, and exit-code propagation exactly like the built-ins.

### AI SDK tool

```typescript
import { Bash, createBashTool } from "@ag-bash/bash";

const bash = new Bash({ files: { "/data/users.json": '[{"name":"Alice"}]' } });
const { tools } = createBashTool({ sandbox: bash });

// `tools` is a Vercel AI SDK tool set keyed by tool name
// ("bash", "read_file", "grep_search", …). Pass it to generateText().
```

### Agent RunLoop

```typescript
import { Bash } from "@ag-bash/bash";
import { type LLMProvider, RunLoop } from "@ag-bash/bash/agent-runtime";

const llm: LLMProvider = {
  async generate(request) {
    // Call your model with request.messages / request.tools and map the reply.
    return { content: "done", stopReason: "end_turn" };
  },
};

const bash = new Bash({ agentic: { enabled: true } });
const loop = new RunLoop(bash, {
  llm,
  systemPrompt: "You are a shell agent operating inside a sandbox.",
  budget: { maxTurns: 10, maxTokens: 100000 },
});

const outcome = await loop.run("Summarise every TODO comment under /src");
console.log(outcome.status, outcome.turns);
```

## Export Paths

| Import Path | Contents |
|---|---|
| `@ag-bash/bash` | Core API: `Bash`, `createShell`, `shellEscape`, `defineCommand`, `createBashTool` |
| `@ag-bash/bash/agent-runtime` | `RunLoop`, `BudgetManager`, `LLMProvider` |
| `@ag-bash/bash/testing` | `createTestBash`, `assertSuccess`, `assertFails`, fixtures |
| `@ag-bash/bash/ai` | Multi-framework adapters (OpenAI, Anthropic, LangChain, Vercel) |
| `@ag-bash/bash/slim` | Minimal API surface for bundle-sensitive environments |
| `@ag-bash/bash/advanced` | Full internal surface for power users |
| `@ag-bash/bash/browser` | Browser build (also selected via the `browser` condition) |
| `@ag-bash/bash/browser-core` | Smallest browser build, without optional runtimes |

## Key Features

- **112 built-in commands** — `grep`, `sed`, `awk`, `jq`, `find`, `xargs`, and more
- **Pluggable filesystems** — InMemory (default), Overlay (copy-on-write), ReadWrite (real disk), Mountable (multi-mount)
- **Full shell syntax** — Pipes, redirections, loops, functions, globs, variable expansion
- **Optional runtimes** — Python (CPython/WASM) and JavaScript (QuickJS/WASM)
- **Agentic tools** — `ag-edit`, `ag-diff`, `ag-snapshot`, `ag-analyze`, `ag-todo`, `ag-plan`
- **Custom commands** — Extend with `defineCommand()` and full pipe/redirect support
- **Security-first** — No host filesystem access by default, no network, prototype-pollution hardened
- **Zero native deps** — Pure TypeScript, runs in Node.js and browsers

## Supported Commands

112 built-in commands, plus `curl` (network, opt-in) and two WASM runtimes.

**Text processing**: `awk`, `cat`, `column`, `comm`, `cut`, `egrep`, `expand`, `fgrep`, `fold`, `grep`, `head`, `join`, `nl`, `paste`, `rev`, `rg`, `sed`, `sort`, `strings`, `tac`, `tail`, `tee`, `tr`, `unexpand`, `uniq`, `wc`, `xargs`

**Data processing**: `jq` (JSON), `yq` (YAML/XML/TOML/CSV/INI), `xan` (CSV), `sqlite3` (SQLite), `js-exec` (JavaScript/TypeScript via QuickJS), `python3` and `python` (CPython via WASM)

**File operations**: `basename`, `chmod`, `cp`, `dirname`, `du`, `file`, `find`, `ln`, `ls`, `mkdir`, `mv`, `od`, `pwd`, `readlink`, `rm`, `rmdir`, `split`, `stat`, `touch`, `tree`

**Archives, encoding and hashing**: `base64`, `gunzip`, `gzip`, `md5sum`, `sha1sum`, `sha256sum`, `tar`, `zcat`

**Shell and environment**: `alias`, `bash`, `clear`, `echo`, `env`, `expr`, `false`, `history`, `hostname`, `printenv`, `printf`, `seq`, `sh`, `true`, `unalias`, `whoami`

**Time and control**: `date`, `sleep`, `time`, `timeout`

**Comparison and conversion**: `diff`, `html-to-markdown`

**Introspection**: `about`, `commands`, `doctor`, `hello`, `help`, `which`

**Version control**: `git` — in-VFS init / add / commit / log tracking

**Network** (opt-in, requires a URL allowlist): `curl`

**Code intelligence**: `ag-analyze`, `ag-explain`, `ag-find-symbol`, `ag-hover`, `ag-references`

**Editing, diffing and conversion**: `ag-convert`, `ag-diff`, `ag-edit`, `ag-notebook`, `ag-snapshot`

**Agentic search**: `ag-find-files`, `ag-glob`, `ag-grep`

**Agent orchestration**: `ag-cron`, `ag-list-agents`, `ag-mcp`, `ag-message`, `ag-plan`, `ag-spawn`, `ag-task`, `ag-team`, `ag-todo`, `ag-wait`, `ag-worktree`

All commands support `--help` for usage details. `node` is accepted as an alias that redirects to `js-exec`.

## Configuration

```typescript
const bash = new Bash({
  files: { "/data/config.json": '{"key": "value"}' },
  env: { NODE_ENV: "production" },
  cwd: "/app",
  runtimes: { python: true, javascript: true },
  agentic: { enabled: true },
});
```

## Security Model

- In-memory filesystem by default (no host access)
- No network access unless explicitly allowed via URL allowlists
- Python/JS runtimes disabled by default
- Prototype-pollution defenses via null-prototype objects throughout

## Install & Distribution

Ag-Bash ships across multiple channels, all synchronized at the current `6.0.4` baseline:

```bash
# npm — core engine library
npm i @ag-bash/bash

# MCP server in Claude Code (exposes 70 tools over stdio)
claude mcp add ag-bash -- npx -y @ag-bash/mcp-server

# Claude Code plugin
/plugin marketplace add sairam0424/ag-bash
/plugin install ag-bash@ag-bash

# Homebrew (installs ag-bash, ag-shell, ag-bash-mcp bins)
brew tap sairam0424/tap && brew install ag-bash
```

Also published to the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.sairam0424/ag-bash`. A Docker MCP Catalog submission is in review.

## Links

- [GitHub Repository](https://github.com/sairam0424/ag-bash)
- [MCP Server](https://www.npmjs.com/package/@ag-bash/mcp-server)
- [Agent Bridge](https://www.npmjs.com/package/@ag-bash/agent-bridge)

## License

Apache-2.0
