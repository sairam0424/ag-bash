# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ag-Bash is an AI-native bash interpreter written in TypeScript. It is organized as a pnpm monorepo:

- **`@ag-bash/bash`**: The core shell engine, filesystem, and sandboxed runtimes.
- **`@ag-bash/agent-bridge`**: Terminal UI bridge for AI agent communication.
- **`@ag-bash/mcp-server`**: Standalone Model Context Protocol server.

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

```
Input Script → Parser (src/parser/) → AST (src/ast/) → Interpreter (src/interpreter/) → ExecResult
```

### Key Modules

- **Parser**: Recursive descent parser producing AST nodes.
- **Interpreter**: Core execution loop with word expansion and arithmetic support.
- **Filesystem**: Pluggable VFS (InMemory, Overlay, ReadWrite).
- **Runtimes**: CPython (WASM) and QuickJS (WASM) for cross-language scripting.

## Development Guidelines

- **Null Prototypes**: All `Record<string, T>` must use null prototypes via `Object.create(null)` or `nullPrototype()` to prevent prototype pollution.
- **Security Gates**: All filesystem access MUST go through `resolveAndValidate` security gates in the respective FS implementation.
- **Sandbox Pure**: No Node.js native dependencies allowed in the core package (except optional WASM runtimes).
- **Versioning**: Maintain synchronized versioning across monorepo packages (currently v1.3.0).
- **E2E First**: Always verify changes with `bash scripts/e2e-verify.sh` to ensure protocol and persistence stability.
