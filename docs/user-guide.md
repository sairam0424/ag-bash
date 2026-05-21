# Ag-Bash User Guide: The Agentic Shell (v3.0.0)

Welcome to **Ag-Bash**, the industry-standard secure runtime designed specifically for AI agents and high-fidelity virtual environments. This guide walks you through the core concepts, installation, and advanced workflows of the Ag-Bash ecosystem.

> **Version note**: This guide covers Ag-Bash v3.0.0. If you are upgrading from v2.x, see the [Migration](#migrating-from-v2x) section below for breaking changes.

---

## Getting Started

Ag-Bash is not just a terminal; it is a **Secure Unified Agentic Runtime**. It allows you to run Bash, Python, and JavaScript in a single, byte-transparent virtualized environment.

### 1. Installation

Ag-Bash is typically used as a dependency in monorepos or as a standalone CLI.

```bash
# Clone and Setup
git clone https://github.com/sairam0424/ag-bash.git
cd ag-bash
pnpm install
pnpm build
```

### 2. Launching the Interactive Shell

The `ag-shell` is your playground for human-in-the-loop debugging.

```bash
cd packages/bash
pnpm shell
```

---

## Configuration

In v3.0.0, the `BashOptions` API uses **grouped sub-objects** instead of flat top-level fields. This makes configuration more discoverable and keeps related settings together.

```typescript
import { Bash } from "@ag-bash/bash";

const shell = new Bash({
  // Core options remain flat
  cwd: "/workspace",
  env: { NODE_ENV: "development" },

  // Runtimes (previously top-level `python` / `javascript`)
  runtimes: {
    python: true,
    javascript: { bootstrap: "globalThis.agent = {};" },
  },

  // Security (previously top-level `defenseInDepth` / `processInfo`)
  security: {
    defenseInDepth: true,
    processInfo: { pid: 1000, uid: 501 },
  },

  // Parser (previously top-level `parserEngine` / `treeSitterConfig`)
  parser: {
    engine: "tree-sitter",
  },

  // Agentic (previously a boolean flag)
  agentic: {
    enabled: true,
    healer: { maxRetries: 3 },
    nestingDepth: 4,
    permissionHandler: { ask: async (msg) => confirm(msg) },
  },

  // Debug & Observability (previously top-level `logger` / `trace` / etc.)
  debug: {
    logger: myLogger,
    trace: (event) => console.log(event),
  },

  // Resource limits (previously `maxCallDepth` / `maxCommandCount` / `maxLoopIterations`)
  executionLimits: {
    maxCallDepth: 64,
    maxCommandCount: 50_000,
    maxLoopIterations: 100_000,
  },
});
```

### ServiceContainer and Dependency Injection

Every `Bash` instance in v3.0.0 owns its own **service graph**. There are no shared singletons (the v2.x `SharedStateBus` singleton pattern has been removed). This guarantees full isolation when you run multiple shell instances in the same process.

You can access services on a running instance:

```typescript
const shell = new Bash({ agentic: { enabled: true } });

// Access the per-instance service container
const { astCache, sharedBus, mcpClient, sessionManager } = shell.services;

// Check AST cache performance
console.log(astCache.stats()); // { hits: 42, misses: 3 }
```

For testing, you can inject custom service implementations:

```typescript
import { Bash, createDefaultServices } from "@ag-bash/bash";

const mockServices = createDefaultServices({
  mcpClient: new MockMcpClient(),
  agentMemory: new InMemoryAgentMemory(),
});

const testShell = new Bash({ services: mockServices });
```

---

## Core Architecture

Ag-Bash operates on three foundational pillars:

### OverlayFS (The Mirror Filesystem)

Ag-Bash uses a **Copy-on-Write (CoW)** filesystem.

- **Read**: It mirrors your local project files exactly.
- **Write**: All modifications stay in a virtual memory layer.
- **Benefit**: Your real codebase is never accidentally deleted by an agent, but the agent *thinks* it is working on real files.

### Agentic Healer

When a command fails, Ag-Bash doesn't just error out. It performs a semantic analysis of the failure and provides **LLM-ready observations**.

- **Fuzzy Matching**: Detects typos in variables and provides "Did you mean?" suggestions for commands and file paths using Levenshtein distance.
- **Nexus Intelligence**: Uses structural analysis to suggest fixes for missing functions or misconfigured scripts.

### Defense-in-Depth

Ag-Bash implements absolute isolation using WASM runtimes. Even if an agent tries to run malicious code, it is trapped within the virtual machine.

---

## Pro Workflows

### The "Synergy" Pipeline
Combine different runtimes in a single pipeline.

```bash
# Scrape HTML, convert to Markdown, process with Python, filter with JQ
curl -s https://example.com | \
html-to-markdown | \
python3 -c "import sys; print(sys.stdin.read().upper())" | \
jq -R '.'
```

### Database Experimentation
Test high-performance SQL queries without setting up a DB server.

```bash
echo "CREATE TABLE logs (msg TEXT); INSERT INTO logs VALUES ('Agent started'); SELECT * FROM logs;" | sqlite3 :memory:
```

### The "Nexus" Workflow (Autonomous Repair)
Use the Nexus suite (`ag-edit`, `ag-diff`, `ag-snapshot`) to analyze, edit, and verify code changes safely.

```bash
# 1. Capture a baseline snapshot
ag-snapshot save nexus-pre-fix

# 2. Analyze script symbols
ag-analyze --symbols lib/utils.sh

# 3. Apply a surgical edit
ag-edit replace --target "old_config" --replacement "new_config" config.yaml

# 4. Verify the semantic diff
ag-diff config.yaml --summary

# 5. Restore if validation fails
ag-snapshot restore nexus-pre-fix
```

### Plan Mode (Safe Multi-Step Design)

Plan Mode puts the shell into a **read-only** state where destructive tools are blocked. Use it when an agent needs to design a multi-step solution, inspect files, and draft edits before committing any changes.

```bash
# Enter plan mode
ag-plan start

# In plan mode: reads, searches, and analysis are allowed.
# Writes, deletes, and destructive commands are rejected.
ag-edit replace --target "foo" --replacement "bar" main.sh
# → Error: destructive tools blocked in plan mode

# Commit the plan and switch back to execute mode
ag-plan commit
```

### MCP Client Integration

Ag-Bash includes a built-in Model Context Protocol client. You can connect to external MCP servers and invoke their tools directly from the shell.

```bash
# Connect to an MCP server (Stdio transport)
ag-mcp connect --name my-server -- node /path/to/mcp-server.js

# List discovered tools
ag-mcp tools my-server

# Invoke a remote tool
ag-mcp call my-server tool_name '{"arg": "value"}'

# Disconnect
ag-mcp disconnect my-server
```

The MCP client supports both **Stdio** (process spawning) and **HTTP** transports. Tool schemas are automatically discovered and validated.

---

## Migrating from v2.x

If you are upgrading from Ag-Bash v2.x, here are the changes that require code updates:

### BashOptions field mapping

| v2.x (flat)              | v3.0.0 (grouped)                          |
|--------------------------|--------------------------------------------|
| `python`                 | `runtimes.python`                          |
| `javascript`             | `runtimes.javascript`                      |
| `defenseInDepth`         | `security.defenseInDepth`                  |
| `processInfo`            | `security.processInfo`                     |
| `parserEngine`           | `parser.engine`                            |
| `treeSitterConfig`       | `parser.treeSitterConfig`                  |
| `agentic` (boolean)      | `agentic.enabled`                          |
| `healer` / `agenticConfig` | `agentic.healer`                        |
| `permissionHandler`      | `agentic.permissionHandler`                |
| `nestingDepth`           | `agentic.nestingDepth`                     |
| `logger`                 | `debug.logger`                             |
| `trace`                  | `debug.trace`                              |
| `coverage`               | `debug.coverage`                           |
| `debugger`               | `debug.debugger`                           |
| `semanticEngine`         | `debug.semanticEngine`                     |
| `maxCallDepth`           | `executionLimits.maxCallDepth`             |
| `maxCommandCount`        | `executionLimits.maxCommandCount`          |
| `maxLoopIterations`      | `executionLimits.maxLoopIterations`        |

### Singletons removed

In v2.x you may have accessed global singletons like `AgentManager.instance` or `SessionManager.shared`. In v3.0.0, all services are per-instance. Access them through `bash.services`:

```typescript
// v2.x (removed)
const session = SessionManager.shared;

// v3.0.0
const shell = new Bash({ /* ... */ });
const session = shell.services.sessionManager;
```

---

## Reference Links
- [Command Registry](./COMMAND_REGISTRY.md) - Full list of supported tools.
- [Data Intel Registry](./registry/data_intel.md) - Deep dive into SQL, JQ, and XAN.
- [Runtimes Guide](./registry/agentic_runtimes.md) - Master Python and JS integration.
