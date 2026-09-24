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

```typescript
// Direct execution
import { Bash } from "@ag-bash/bash";
const bash = new Bash();
const result = await bash.exec("echo hello");
console.log(result.stdout); // "hello\n"

// Tagged template (zx-style)
import { createShell } from "@ag-bash/bash";
const $ = createShell();
const name = "world";
await $`echo ${name}`;

// Agent RunLoop
import { RunLoop } from "@ag-bash/bash/agent-runtime";
```

## Export Paths

| Import Path | Contents |
|---|---|
| `@ag-bash/bash` | Core API: `Bash`, `createShell`, `shellEscape`, `defineCommand` |
| `@ag-bash/bash/agent-runtime` | `RunLoop`, `BudgetManager`, `LLMProvider` |
| `@ag-bash/bash/testing` | `createTestBash`, assertions, fixtures |
| `@ag-bash/bash/ai` | Multi-framework adapters (OpenAI, Anthropic, LangChain, Vercel) |
| `@ag-bash/bash/slim` | Minimal API surface for bundle-sensitive environments |
| `@ag-bash/bash/advanced` | Full internal surface for power users |

## Custom Commands

Extend the shell with your own TypeScript commands via `defineCommand`:

```typescript
import { Bash, defineCommand } from "@ag-bash/bash";

const hello = defineCommand("hello", async (args, ctx) => {
  const name = args[0] || "world";
  return { stdout: `Hello, ${name}!\n`, stderr: "", exitCode: 0 };
});

const bash = new Bash({ customCommands: [hello] });
await bash.exec("hello Alice"); // "Hello, Alice!\n"
```

## Filesystems

Mount a real directory read-only with `OverlayFs` — writes stay in-memory (copy-on-write) and never touch disk:

```typescript
import { Bash } from "@ag-bash/bash";
import { OverlayFs } from "@ag-bash/bash/fs/overlay-fs";

const fs = new OverlayFs({ root: "/path/to/project" });
const bash = new Bash({ fs });

await bash.exec("cat package.json"); // reads the real file
await bash.exec("echo 'test' > notes.txt"); // written to memory only
```

## Agent RunLoop

Pair an LLM with the shell for autonomous, budgeted execution via `@ag-bash/bash/agent-runtime`:

```typescript
import { Bash } from "@ag-bash/bash";
import { RunLoop, type LLMProvider } from "@ag-bash/bash/agent-runtime";

const myLLMProvider = {} as LLMProvider; // supply your own provider implementation

const bash = new Bash({ agentic: { enabled: true } });
const loop = new RunLoop(bash, {
  llm: myLLMProvider,
  systemPrompt: "You are a code repair agent.",
  budget: { maxTurns: 20, maxTokens: 100_000 },
});

const result = await loop.run("Fix the failing test in src/parser.ts");
console.log(result.status, result.turns, result.finalOutput);
```

## AI SDK Integration

Expose the shell as a tool for OpenAI, Anthropic, Vercel AI SDK, or LangChain agents via `@ag-bash/bash/ai`:

```typescript
import { Bash } from "@ag-bash/bash";
import { createBashTool } from "@ag-bash/bash/ai";

const bash = new Bash({ files: { "/data/users.json": "[]" } });
const tool = createBashTool({ sandbox: bash });

const vercelTool = tool.forVercel();
```

## Supported Commands

### File Operations

`cat`, `chmod`, `cp`, `du`, `file`, `ln`, `ls`, `mkdir`, `mv`, `readlink`, `rm`, `rmdir`, `split`, `stat`, `touch`, `tree`

### Text Processing

`awk`, `base64`, `column`, `comm`, `cut`, `diff`, `expand`, `fold`, `grep`, `egrep`, `fgrep`, `rg`, `head`, `join`, `md5sum`, `nl`, `od`, `paste`, `printf`, `rev`, `sed`, `sha1sum`, `sha256sum`, `sort`, `strings`, `tac`, `tail`, `tr`, `unexpand`, `uniq`, `wc`, `xargs`

### Data & Format Processing

`git`, `jq`, `sqlite3`, `xan`, `yq`

### Optional Runtimes

`js-exec`, `python3`, `python`

### Compression & Archives

`gzip`, `gunzip`, `zcat`, `tar`

### Navigation & Environment

`basename`, `dirname`, `echo`, `env`, `find`, `hostname`, `printenv`, `pwd`, `tee`

### Shell & Discovery Utilities

`about`, `alias`, `bash`, `clear`, `commands`, `date`, `doctor`, `expr`, `false`, `hello`, `help`, `history`, `seq`, `sh`, `sleep`, `time`, `timeout`, `true`, `unalias`, `which`, `whoami`

### Network

`curl`, `html-to-markdown`

### Agentic Tooling

`ag-analyze`, `ag-convert`, `ag-cron`, `ag-diff`, `ag-edit`, `ag-explain`, `ag-find-files`, `ag-find-symbol`, `ag-glob`, `ag-grep`, `ag-hover`, `ag-list-agents`, `ag-mcp`, `ag-message`, `ag-notebook`, `ag-plan`, `ag-references`, `ag-snapshot`, `ag-spawn`, `ag-task`, `ag-team`, `ag-todo`, `ag-wait`, `ag-worktree`

All commands support `--help` for usage information. See the [Command Registry](../../docs/COMMAND_REGISTRY.md) for the full flag-by-flag reference.

## Key Features

- **100+ built-in commands** — `grep`, `sed`, `awk`, `jq`, `find`, `xargs`, and more
- **Pluggable filesystems** — InMemory (default), Overlay (copy-on-write), ReadWrite (real disk), Mountable (multi-mount)
- **Full shell syntax** — Pipes, redirections, loops, functions, globs, variable expansion
- **Optional runtimes** — Python (CPython/WASM) and JavaScript (QuickJS/WASM)
- **Agentic tools** — `ag-edit`, `ag-diff`, `ag-snapshot`, `ag-analyze`, `ag-todo`, `ag-plan`
- **Custom commands** — Extend with `defineCommand()` and full pipe/redirect support
- **Security-first** — No host filesystem access by default, no network, prototype-pollution hardened
- **Zero native deps** — Pure TypeScript, runs in Node.js and browsers

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
