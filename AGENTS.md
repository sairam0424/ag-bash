# Repository Guidelines

## Project Structure & Module Organization

Ag-Bash is a pnpm monorepo with three primary packages: `@ag-bash/bash` (core shell engine, filesystem, sandboxed runtimes), `@ag-bash/mcp-server` (standalone Model Context Protocol server), and `@ag-bash/agent-bridge` (terminal UI bridge). The core execution pipeline flows from input script through the tree-sitter parser (`src/parser/`) to AST (`src/ast/`) to interpreter (`src/interpreter/`) yielding execution results. Key modules include the Parser (with ASTCache), Interpreter (SharedStateBus and resource accounting), pluggable Filesystem (InMemory, Overlay, ReadWrite), and WASM Runtimes (CPython and QuickJS with SharedStateBus bridge).

## Build, Test, and Development Commands

```bash
# Full monorepo force build
bash scripts/force-build.sh

# Install dependencies
pnpm install

# Type check all packages
pnpm typecheck

# Run full E2E verification suite
bash scripts/e2e-verify.sh

# Build all packages
pnpm build

# Lint all packages
pnpm lint

# Fix linting issues
pnpm --filter @ag-bash/bash lint:fix
```

### Core Engine (`@ag-bash/bash`)

```bash
# Run ALL engine tests
pnpm --filter @ag-bash/bash test:run

# Fast unit tests only
pnpm --filter @ag-bash/bash test:unit

# WASM runtime tests (python, sqlite, js-exec)
pnpm --filter @ag-bash/bash test:wasm

# Interactive shell
pnpm --filter @ag-bash/bash shell
```

### MCP Server (`@ag-bash/mcp-server`)

```bash
# Bundle standalone MCP binary
pnpm --filter @ag-bash/mcp-server build
```

## Coding Style & Naming Conventions

Enforced by **Biome** with strict rules:

- **Strict TypeScript**: Enabled with `isolatedDeclarations`.
- **No explicit `any`**: Use proper types (error level).
- **No unused imports/variables**: All imports and variables must be used (error level).
- **No non-null assertions (`!`)**: Use proper null checks (error level).
- **Template strings required**: Use template literals instead of string concatenation (error level).
- **Regex restrictions**: Use `createUserRegex()` for user patterns or `new ConstantRegex()` for internal patterns instead of raw `RegExp` constructor (see `src/regex/index.ts`). Exception: test files and `regex/` directory.
- **Formatting**: 2-space indentation.

## Testing Guidelines

**Framework**: Vitest

**Test commands**:
- `pnpm --filter @ag-bash/bash test:run` — Full test suite excluding fuzzing and WASM tests.
- `pnpm --filter @ag-bash/bash test:unit` — Fast unit tests using `vitest.unit.config.ts`.
- `pnpm --filter @ag-bash/bash test:wasm` — WASM runtime tests using `vitest.wasm.config.ts`.
- `pnpm --filter @ag-bash/bash test:comparison` — Comparison tests.

**To run a single test file**: `vitest run path/to/test.test.ts`

## Security & Architecture Constraints

- **Null prototypes required**: All `Record<string, T>` must use `Object.create(null)` or `nullPrototype()` to prevent prototype pollution.
- **Filesystem security gates**: All filesystem access must go through `resolveAndValidate` security gates in the respective FS implementation.
- **Sandbox purity**: No Node.js native dependencies allowed in the core package (except optional WASM runtimes).
- **Synchronized versioning**: Maintain synchronized versioning across monorepo packages (currently v2.0.0).
- **E2E verification**: Always verify changes with `bash scripts/e2e-verify.sh` to ensure protocol and persistence stability.

## CI/CD

GitHub Actions workflows:
- `unit-tests.yml` — Core unit tests
- `python-tests.yml` — Python WASM tests
- `comparison-tests.yml` — Comparison tests
- `lint.yml` — Linting checks
- `typecheck.yml` — Type checking
