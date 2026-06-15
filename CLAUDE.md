# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ag-Bash is an AI-native bash interpreter written in TypeScript. It is organized as a pnpm monorepo:

- **`@ag-bash/bash`**: The core shell engine, filesystem, and sandboxed runtimes.
- **`@ag-bash/agent-bridge`**: Terminal UI bridge for AI agent communication.
- **`@ag-bash/mcp-server`**: Standalone Model Context Protocol server.
- **Version Baseline**: `6.0.4` (fixed-mode synchronized across all packages)

## Distribution

Ag-Bash ships across multiple channels, all at the current `6.0.4` baseline (owner `sairam0424`, Apache-2.0):

```bash
# npm (library + servers, synchronized at 6.0.4)
npm i @ag-bash/bash                                 # core engine library
npx @ag-bash/mcp-server                             # standalone MCP server (70 tools, stdio)

# MCP server in Claude Code
claude mcp add ag-bash -- npx -y @ag-bash/mcp-server

# Claude Code plugin
/plugin marketplace add sairam0424/ag-bash
/plugin install ag-bash@ag-bash

# Homebrew (installs ag-bash, ag-shell, ag-bash-mcp bins)
brew tap sairam0424/tap && brew install ag-bash
```

- **MCP Registry**: `io.github.sairam0424/ag-bash` @ `6.0.4` (active, isLatest) at registry.modelcontextprotocol.io.
- **Docker MCP Catalog**: submission PR open at `docker/mcp-registry` (in review; not yet merged).

## Commands

### Global Workspace Commands

```bash
# Build & Setup
bash scripts/force-build.sh   # Full monorepo force build (Core + MCP)
pnpm install                 # Install dependencies
pnpm typecheck               # Type check all packages

# Verification
bash scripts/e2e-verify.sh   # Run full E2E verification suite
```

### Core Engine Commands (`packages/bash`)

```bash
# Testing
pnpm --filter @ag-bash/bash test:run      # Run ALL engine tests
pnpm --filter @ag-bash/bash test:unit     # Fast unit tests
pnpm --filter @ag-bash/bash test:wasm     # WASM runtimes (python, sqlite)

# Interactive Development
pnpm --filter @ag-bash/bash shell         # Run the interactive ag-shell
```

### MCP Server Commands (`packages/mcp-server`)

```bash
# Production Bundling
pnpm --filter @ag-bash/mcp-server build   # Bundle standalone MCP binary
```

## Architecture

### Core Pipeline (`@ag-bash/bash`)

```text
Input Script → ExecutionPipeline [Normalize → Parse (src/parser/lexer/) → Transform → Sandbox → Interpret (src/interpreter/) → Persist] → BashExecResult
```

### Key Modules

- **Lexer**: Tokenization layer in `src/parser/lexer/` subdirectory.
- **Parser**: Tree-sitter powered recursive descent parser with `ASTCache`.
- **ExecutionPipeline**: The default (and sole) execution engine since v6.0.0. Composable 6-stage pipeline.
- **Interpreter**: Core execution loop with SharedStateBus and Resource Accounting.
- **Filesystem**: Pluggable VFS (InMemory, Overlay, ReadWrite, Mountable).
- **Runtimes**: CPython (WASM) and QuickJS (WASM) with SharedStateBus bridge.
- **BashToolbox**: Builtin command implementations in `src/agentic/toolbox/` subdirectory.
- **Streaming**: `execStream()` yields incremental output chunks via AsyncGenerator.
- **Fork-Speculation**: `bash.fork()` and `bash.speculate()` for isolated branching.

### ServiceContainer (v6.0.0)

- **Lazy initialization**: All services are lazily constructed on first access (registry pattern).
- **Eager services** (instantiated at container creation): `astCache`, `sharedBus`.
- **BashHost interface**: Typed command dispatch via the `BashHost` interface (expanded with `fs`, `nestingDepth`, `getCwd()`, `getEnv()`). Sub-agent tool filtering uses immutable constructor-time allowlists.
- **AsyncDisposable**: The `Bash` instance implements `AsyncDisposable` (`await using bash = ...`) for deterministic cleanup.

## Development Guidelines

- **Null Prototypes**: All `Record<string, T>` must use null prototypes via `Object.create(null)` or `nullPrototype()` to prevent prototype pollution.
- **Security Gates**: All filesystem access MUST go through `resolveAndValidate` security gates in the respective FS implementation.
- **Sandbox Pure**: No Node.js native dependencies allowed in the core package (except optional WASM runtimes).
- **Defense-in-Depth Defaults**: `defenseInDepth` defaults to enabled — all sandbox contexts automatically block `Function`, `eval`, `setTimeout`, and `process.*` unless explicitly opted out.
- **Synchronized versioning**: Maintain synchronized versioning across monorepo packages (currently `6.0.4`, fixed-mode synchronized).
- **Nexus Suite**: Integrated surgical editing (`ag-edit`), semantic diffing (`ag-diff`), and snapshots (`ag-snapshot`).
- **E2E First**: Always verify changes with `bash scripts/e2e-verify.sh` to ensure protocol and persistence stability.
