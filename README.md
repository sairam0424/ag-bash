# Ag-Bash: The AI-Native Shell Monorepo

[![NPM Version](https://img.shields.io/npm/v/@ag-bash/bash.svg)](https://www.npmjs.com/package/@ag-bash/bash)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/sairam0424/ag-bash/blob/main/LICENSE)

Ag-Bash is a production-grade, sandboxed Bash environment designed specifically for AI agents. It provides a virtualized Unix-like experience entirely in-process, featuring an in-memory filesystem, integrated runtimes for Python and JavaScript, and full support for modern agentic protocols.

## 🏗️ Monorepo Architecture

This repository is organized into a modular monorepo to support independent versioning and consumption of core engine components and protocol adapters.

| Package | Version | Description |
| :--- | :--- | :--- |
| [`@ag-bash/bash`](./packages/bash) | [![npm](https://img.shields.io/npm/v/@ag-bash/bash.svg)](https://www.npmjs.com/package/@ag-bash/bash) | **Core Engine**: The virtual shell, filesystem, and sandboxed runtimes. |
| [`@ag-bash/mcp-server`](./packages/mcp-server) | [![npm](https://img.shields.io/npm/v/@ag-bash/mcp-server.svg)](https://www.npmjs.com/package/@ag-bash/mcp-server) | **MCP Server**: A standalone Model Context Protocol server for seamless agent integration. |
| [`@ag-bash/agent-bridge`](./packages/agent-bridge) | [![npm](https://img.shields.io/npm/v/@ag-bash/agent-bridge.svg)](https://www.npmjs.com/package/@ag-bash/agent-bridge) | **Agent Bridge**: Terminal UI bridge for AI agent communication. |

---

## What's New in v6.0.0

| Feature | Description |
| :--- | :--- |
| **ExecutionPipeline** | The composable 6-stage pipeline (normalize, parse, transform, sandbox, interpret, persist) is now the sole execution engine. The legacy monolith path has been removed. |
| **Fork-Speculation** | `bash.fork()` creates isolated copy-on-write branches; `bash.speculate()` runs N candidates in parallel and keeps the winner. Core moat for agentic workflows. |
| **Observations at Source** | Every command produces typed `Observation` objects with `code` and `confidence` fields, surfacing issues without blocking execution. |
| **True Streaming** | `bash.execStream()` yields stdout/stderr chunks via AsyncGenerator as statements produce output, byte-identical to buffered exec. |
| **RunLoop v2** | Extended with `mode`, `healer`, and `memory` configuration. AgentMemory now persists across sessions. |
| **MCP 2025-06-18** | Protocol bumped to latest spec with back-compat preserved for 2024-11-05 clients. Code Mode slice for structured output. |
| **Destructive Detection** | AST-based gate detects `rm -rf /`, fork bombs, and decode-pipe-to-shell patterns structurally. Default policy: WARN. |
| **OTEL at Exec Level** | Optional `AgBashTracer` wraps each `exec()` call in an OpenTelemetry span. Zero overhead when `@opentelemetry/api` is absent. |

---

## Installation

**Requires Node.js >=20.6.0.** For full ESM-hook security hardening, Node.js >=23.5 is recommended.

```bash
# Latest (recommended)
npm install @ag-bash/bash

# With MCP server
npm install @ag-bash/mcp-server
```

**Subpath imports** for tree-shaking and targeted use:

```typescript
import { Bash, createShell } from "@ag-bash/bash";
import { RunLoop } from "@ag-bash/bash/agent-runtime";
import { createTestBash } from "@ag-bash/bash/testing";
```

---

## 🚀 Quick Start

### For Developers (Library)

If you are building an application and want to embed a sandboxed shell:

```bash
npm install @ag-bash/bash
```

```typescript
import { Bash, createShell } from "@ag-bash/bash";

// Quick instantiation
const bash = new Bash();
const result = await bash.exec('echo "Hello Ag-Bash"');
console.log(result.stdout); // "Hello Ag-Bash\n"

// Or use createShell for full configuration
const shell = createShell({ filesystem: "overlay", cwd: "/workspace" });
await shell.exec("ls -la");
```

### 2. Standalone CLI & Shell (Global)

For human-in-the-loop debugging and interactive use, install the Ag-Bash suite globally.

#### Via Homebrew (macOS)

```bash
brew tap ag-bash/homebrew-tap
brew install ag-bash
```

#### Via NPM (Cross-platform)

```bash
npm install -g @ag-bash/bash @ag-bash/mcp-server
```

---

### For AI Agents (MCP)

To provide a bash environment to your agent (e.g., in Claude Desktop or Cursor):

```bash
npm install -g @ag-bash/mcp-server
```

Then, add the server to your MCP configuration:

```json
{
  "mcpServers": {
    "ag-bash": {
      "command": "ag-bash-mcp",
      "args": []
    }
  }
}
```

---

## 🛡️ Key Features

- **v6.0 Architecture**: ExecutionPipeline as sole engine, fork-speculation, observations-at-source, true streaming, OTEL tracing, destructive-detection gate.
- **v6.0 RunLoop**: Autonomous LLM execution loop with observation forwarding, AgenticHealer self-correction, AgentMemory persistence, plan-mode write-gating, and BudgetManager stopping conditions.
- **v3.0 DI** *(Breaking)*: Dependency Injection via `ServiceContainer`, restructured `BashOptions` API with grouped sub-objects, and zero singletons.
- **FNV-1a ASTCache**: Non-cryptographic hashing with true LRU eviction for high-frequency script execution.
- **Pipeline Early Termination**: Static AST analysis detects `head -N` patterns and truncates upstream output.
- **Type-Safe Core**: Eliminated `any` types from core services, interpreter, and error hierarchy (`unknown` throughout).
- **Hardened MCP Server**: Sanitized JSON-RPC error messages (path stripping, length cap), zero console leakage from library code.
- **Project V-Next**: (v2.5.0+) Unified Permission Architecture, Real JSON-RPC MCP Client (Stdio/HTTP), and multi-step Planning Mode.
- **Nexus Prime Suite**: (v2.0.0+) Intelligent semantic analysis (`ag-hover`, `ag-explain`), symbol discovery, and persistent project management.
- **Agentic Healer 2.0**: (v2.4.0+) Tool-aware recovery loop with multi-keyword semantic scoring for automated remediation.
- **High-Fidelity Observability**: (v2.4.0+) EventEmitter-driven tool tracking with `tool:start`, `tool:progress`, and `tool:end` hooks.
- **Tree-sitter AST Parser**: High-fidelity shell parsing for complex scripts and security analysis.
- **Virtual Filesystem**: Choose between `InMemoryFs`, `OverlayFs` (COW), or `ReadWriteFs`.
- **Integrated Runtimes**: Out-of-the-box support for `jq`, `sqlite3`, `python3` (WASM), and `js-exec` (QuickJS).
- **Protocol First**: Full Model Context Protocol (MCP) support with persistent session state.
- **Defense in Depth**: Robust sandbox prevents prototype pollution and unauthorized filesystem access.
- **No Dependencies**: The core engine is lightweight and runs in Node.js or the Browser.

## 📖 Documentation

- **[User Guide](./docs/user-guide.md)**: Narrative introduction to Ag-Bash, installation, and core concepts.
- **[Command Registry](./docs/COMMAND_REGISTRY.md)**: Categorized reference for all 110+ supported tools.
- **[Technical Architecture](./docs/ARCHITECTURE.md)**: Deep dive into the Nexus engine, performance, and resource accounting.
- **[Shell Engine Deep-Dive](./packages/bash/README.md)**: Technical guide for filesystem options and custom commands.
- **[MCP Server Configuration](./packages/mcp-server/README.md)**: Agentic integration patterns and configuration.
- **[Security & Threat Model](./THREAT_MODEL.md)**: Detailed breakdown of the sandbox architecture.

## Version History

| Version | Codename | Highlights |
| :--- | :--- | :--- |
| **v6.0** | *Pipeline* | ExecutionPipeline default, fork-speculation, streaming, OTEL, destructive gate, Node >=20.6 |
| **v5.0** | *Hardened* | Lazy ServiceContainer, defense-in-depth default ON, SSRF prevention, ASTCache 64-bit FNV-1a |
| **v4.1** | *Runtime* | Agent RunLoop, Trap signals, Self-Healing error recovery, OpenTelemetry spans |
| **v3.0** | *Breaking Redesign* | ServiceContainer DI, new `BashOptions` grouped API, zero singletons |
| **v2.x** | *Nexus Prime* | Agentic tools (`ag-hover`, `ag-explain`), MCP integration, Planning Mode |
| **v1.x** | *Genesis* | Initial release, core interpreter, in-memory filesystem, basic builtins |

See the [CHANGELOG](./CHANGELOG.md) for detailed release notes.

---

## 📜 License

Apache-2.0
