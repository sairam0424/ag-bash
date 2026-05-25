# @ag-bash/bash

> AI-Native Sandboxed Bash Runtime for TypeScript

[![npm version](https://img.shields.io/npm/v/@ag-bash/bash?label=npm&color=cb3837)](https://www.npmjs.com/package/@ag-bash/bash)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A complete bash interpreter with an in-memory filesystem, built for AI agents and TypeScript applications. No VM, no Docker, no native dependencies.

## Quick Start

```bash
npm install @ag-bash/bash
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

## Links

- [GitHub Repository](https://github.com/AstroBaseCode/ag-bash)
- [MCP Server](https://www.npmjs.com/package/@ag-bash/mcp-server)
- [Agent Bridge](https://www.npmjs.com/package/@ag-bash/agent-bridge)

## License

Apache-2.0
