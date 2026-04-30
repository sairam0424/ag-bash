# Repository Guidelines

## Project Structure & Module Organization

Ag-Bash is a pnpm monorepo with three primary packages: `@ag-bash/bash` (core shell engine, filesystem, sandboxed runtimes), `@ag-bash/mcp-server` (standalone Model Context Protocol server), and `@ag-bash/agent-bridge` (terminal UI bridge). The core execution pipeline flows from input script through the tree-sitter parser (`src/parser/`) to AST (`src/ast/`) to interpreter (`src/interpreter/`) yielding execution results. Key modules include the Parser (with ASTCache), Interpreter (SharedStateBus and resource accounting), pluggable Filesystem (InMemory, Overlay, ReadWrite), and WASM Runtimes (CPython and QuickJS with SharedStateBus bridge).

## Build, Test, and Development

```bash
pnpm install                                     # Install dependencies
pnpm build                                       # Build all packages
pnpm typecheck                                   # Type check all packages
pnpm lint                                        # Lint all packages
bash scripts/force-build.sh                      # Full monorepo force build
bash scripts/e2e-verify.sh                       # Full E2E verification suite
pnpm --filter @ag-bash/bash validate             # Full pre-publish check (lint + knip + typecheck + build + test)
```

### Core Engine (`@ag-bash/bash`)

```bash
pnpm --filter @ag-bash/bash test:run             # All engine tests (excludes fuzzing and WASM)
pnpm --filter @ag-bash/bash test:unit            # Fast unit tests only
pnpm --filter @ag-bash/bash test:wasm            # WASM runtime tests (python, sqlite, js-exec)
pnpm --filter @ag-bash/bash test:comparison      # Comparison tests
pnpm --filter @ag-bash/bash test:fuzz            # Security fuzzing tests
pnpm --filter @ag-bash/bash test:coverage        # Tests with coverage report
pnpm --filter @ag-bash/bash lint:fix             # Auto-fix linting issues
pnpm --filter @ag-bash/bash lint:banned          # Check for banned code patterns
pnpm --filter @ag-bash/bash knip                 # Dead code detection
pnpm --filter @ag-bash/bash check:worker-sync    # Verify worker files are in sync
pnpm --filter @ag-bash/bash shell                # Interactive shell
```

**Single test file**: `vitest run path/to/test.test.ts`

### MCP Server (`@ag-bash/mcp-server`)

```bash
pnpm --filter @ag-bash/mcp-server build          # Bundle standalone MCP binary
```

## Coding Style & Naming Conventions

Enforced by **Biome** (`biome.json`):

- **Strict TypeScript** with `isolatedDeclarations`.
- **No non-null assertions (`!`)**: error.
- **Template strings required**: error (use template literals, not concatenation).
- **No implicit `any` in let**: error. Explicit `any` is a warning (relaxed in test files).
- **Unused imports/variables**: warning.
- **Regex restrictions**: Use `createUserRegex()` for user patterns or `new ConstantRegex()` for internal patterns instead of raw `RegExp` constructor (see `src/regex/index.ts`). Exception: test files and `regex/` directory.
- **Formatting**: 2-space indentation, organized imports.

## Testing & Commit Conventions

**Framework**: Vitest (with workspace configs for unit, WASM, and comparison suites).

**Commit format**: `type(scope): description` — e.g., `feat(agentic):`, `fix:`, `chore:`, `docs:`, `refactor(agentic):`, `release:`.

## Security & Architecture Constraints

- **Null prototypes required**: All `Record<string, T>` must use `Object.create(null)` or `nullPrototype()` to prevent prototype pollution.
- **Filesystem security gates**: All filesystem access must go through `resolveAndValidate` in the respective FS implementation.
- **Sandbox purity**: No Node.js native dependencies allowed in the core package (except optional WASM runtimes).
- **Synchronized versioning**: Maintain synchronized versioning across monorepo packages (currently v2.6.0).
- **E2E verification**: Always verify changes with `bash scripts/e2e-verify.sh` to ensure protocol and persistence stability.

## CI/CD

GitHub Actions workflows: `unit-tests.yml`, `python-tests.yml`, `comparison-tests.yml`, `lint.yml`, `typecheck.yml`.
