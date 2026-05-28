# Repository Guidelines

## Project Structure & Architecture

Ag-Bash is a pnpm monorepo (v5.0.0) with three packages: `@ag-bash/bash` (core shell engine), `@ag-bash/mcp-server` (MCP protocol server), and `@ag-bash/agent-bridge` (terminal UI bridge).

**v5.0.0 export paths** (in addition to the main `@ag-bash/bash` entry):
- `@ag-bash/bash/agent-runtime` — RunLoop for autonomous agent execution
- `@ag-bash/bash/testing` — Test utilities (`createTestBash`, `assertSuccess`, `assertFails`)

**Core pipeline**: Input Script → Lexer (`src/lexer/`) → Tree-sitter Parser (`src/parser/`) → AST (`src/ast/`) → Interpreter (`src/interpreter/`) → ExecResult

**New in v5.0.0**:
- `src/lexer/` — Tokenization layer split into its own subdirectory
- `src/toolbox/` — Builtin command implementations (BashToolbox) split into subdirectory

**Key architectural patterns**:
- **ServiceContainer DI** (v3.0 breaking change, v5.0.0 lazy rewrite): All services are per-`Bash` instance via `createDefaultServices()`. No singletons except `DefenseInDepthBox` (security necessity). Multiple Bash instances share zero mutable state. In v5.0.0, the container uses lazy initialization (14 lazy, 2 eager: `astCache` + `sharedBus`).
- **BashHost interface**: Typed command dispatch for all builtins via the `BashHost` interface.
- **AsyncDisposable**: `Bash` implements `AsyncDisposable` for deterministic resource cleanup.
- **14 services** in `src/services/`: ASTCache, SharedStateBus, AgentManager, SessionManager, TaskManager, TeamManager, WorktreeManager, AgentMemory, McpClient, Orchestrator, LSPManager, GitTracker, CronScheduler, PermissionManager.
- **Pluggable filesystems**: InMemoryFs, OverlayFs (CoW), ReadWriteFs, MountableFs — all gated by `resolveAndValidate()`.
- **WASM runtimes**: CPython and QuickJS sandboxed via SharedStateBus bridge (opt-in).

## Build, Test, and Development

```bash
pnpm install                                     # Install dependencies
pnpm build                                       # Build all packages (recursive)
pnpm typecheck                                   # Type check all packages
pnpm lint                                        # Lint all packages
bash scripts/force-build.sh                      # Full monorepo force build
bash scripts/e2e-verify.sh                       # Full E2E verification suite
pnpm --filter @ag-bash/bash build:browser-core   # Build browser-compatible core bundle
pnpm --filter @ag-bash/bash validate             # Pre-publish gate: lint + knip + typecheck + build + worker-sync + test + wasm + dist
```

### Core Engine (`@ag-bash/bash`)

```bash
pnpm --filter @ag-bash/bash test:run             # All engine tests (excludes WASM/fuzz)
pnpm --filter @ag-bash/bash test:unit            # Fast unit tests (isolate: false, shared threads)
pnpm --filter @ag-bash/bash test:wasm            # WASM tests (pool: "forks", isolate: true)
pnpm --filter @ag-bash/bash test:comparison      # Compare output vs real bash
pnpm --filter @ag-bash/bash test:comparison:record  # Record new fixtures (RECORD_FIXTURES=1)
pnpm --filter @ag-bash/bash test:fuzz            # Security fuzzing
pnpm --filter @ag-bash/bash test:fuzz:long       # Extended fuzz (FUZZ_RUNS=10000)
pnpm --filter @ag-bash/bash test:coverage        # Tests with v8 coverage
pnpm --filter @ag-bash/bash lint:fix             # Auto-fix linting issues
pnpm --filter @ag-bash/bash lint:banned          # Check 33 banned code patterns
pnpm --filter @ag-bash/bash knip                 # Dead code detection
pnpm --filter @ag-bash/bash check:worker-sync    # Verify worker files in sync
pnpm --filter @ag-bash/bash shell                # Interactive shell (tsx)
```

**Single test**: `pnpm --filter @ag-bash/bash vitest run path/to/test.test.ts`

### MCP Server (`@ag-bash/mcp-server`)

```bash
pnpm --filter @ag-bash/mcp-server build          # Bundle standalone MCP binary
```

## Coding Style

Enforced by **Biome** (`biome.json`) + **TypeScript strict** (`isolatedDeclarations`):

- No non-null assertions (`!`) — error
- Template literals required over concatenation — error
- No implicit `any` — error (relaxed in tests)
- `RegExp` constructor banned — use `createUserRegex()` or `new ConstantRegex()` from `src/regex/index.ts`
- 2-space indentation, organized imports

### Banned Patterns (`scripts/check-banned-patterns.js`)

33 patterns enforced in CI to prevent prototype pollution, code injection, and information leaks:

- `Record<string, T>` declarations → use `Map<string, T>` or `Object.create(null)`
- Empty object literals `{}` → use `Object.create(null)`
- `Object.fromEntries()` → wrap with `Object.assign(Object.create(null), ...)`
- `Object.assign({}, ...)` → use `Object.assign(Object.create(null), ...)`
- `for...in` loops → use `Object.keys()` or `for...of`
- `eval()`, `new Function()` — banned outright
- Dynamic `import()` / `require()` with non-literal specifiers
- Raw `error.message` forwarded to stderr → use `sanitizeErrorMessage()`
- Direct `__proto__` / `constructor.prototype` access
- Raw `await` in defense-sensitive interpreters → use `awaitWithDefenseContext()`

**Auto-safe patterns** (lines pass automatically): `Object.create(null)`, `nullPrototypeCopy()`, `nullPrototypeMerge()`, `isSafeKey()`, `safeGet()`, `safeSet()`, `sanitizeErrorMessage()`, `awaitWithDefenseContext()`, `bindDefenseContextCallback()`

**Opt-out**: `// @banned-pattern-ignore: <reason>` on the same line or up to 2 lines before.

## Testing

**Framework**: Vitest 4.x with multi-config workspace.

**Isolation strategy**:
- **Unit tests** (`vitest.unit.config.ts`): `isolate: false` — shared threads for speed. DefenseInDepthBox singleton reset between files via `vitest-setup.ts`.
- **WASM tests** (`vitest.wasm.config.ts`): `pool: "forks"`, `isolate: true` — full process isolation for Python/SQLite/JS-exec workers and security attack tests.
- **Comparison tests** (`vitest.comparison.config.ts`): Fixture-based. Record real bash output with `RECORD_FIXTURES=1`, compare against ag-bash output.

**Test pattern**:
```typescript
describe("Feature", () => {
  let bash: Bash;
  beforeEach(() => { bash = new Bash({ fs: new InMemoryFs(), files: {...} }); });
  it("should X", async () => {
    const result = await bash.exec("command");
    expect(result.stdout).toBe("expected");
  });
});
```

**464+ test files**: unit, spec (BusyBox format for sed/grep/awk/jq), comparison, and fuzz suites.

**New in v5.0.0** (4 additional test files):
- `lexer/` subdirectory tokenization tests
- `toolbox/` subdirectory builtin command tests
- `service-container.lazy.test.ts` — verifies lazy instantiation behavior
- `async-disposable.test.ts` — verifies deterministic cleanup via `AsyncDisposable`

## Security Constraints (Non-Negotiable)

- **Null prototypes**: All `Record<string, T>` must use `Object.create(null)` or `nullPrototype()` — prototype pollution defense
- **Filesystem gates**: All FS access through `resolveAndValidate()` — closes TOCTOU gap, validates sandbox containment
- **Sandbox purity**: No Node.js natives in core (WASM runtimes opt-in)
- **Regex safety**: `re2js` linear-time engine prevents ReDoS from user patterns
- **Resource accounting**: Memory (50MB default), CPU (30s), Network (100MB), Agent nesting (max 3)
- **Defense-in-depth**: AsyncLocalStorage monkey-patching blocks Function, eval, setTimeout, process.* in sandbox context. **Defaults to enabled** in v5.0.0 (fail-closed).
- **SharedStateBus limits**: Event queue bounded at 10,000 entries; subscribers capped at 256 per topic to prevent resource exhaustion.
- **E2E verification**: Run `bash scripts/e2e-verify.sh` before protocol-affecting commits

## Commit Conventions

Format: `type(scope): description`

**Types**: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `release`
**Scopes**: `agentic`, `security`, `parser`, `services`, `interpreter`, `core`, `cli`, `mcp`, `runtimes`, `hyperion`
**Breaking changes**: append `!` — e.g., `feat(core)!: restructure BashOptions`

## CI/CD

GitHub Actions: `quality.yml` (biome + banned patterns + knip + build + worker-sync + typecheck), `tests.yml` (unit, WASM, comparison, python — Node 20/22/24 matrix).

**Quality pipeline** (`quality.yml`): Biome check → banned patterns script → knip → build → worker sync check → typecheck. Any failure blocks merge.
**Test pipeline** (`tests.yml`): Unit tests → WASM tests → comparison tests → python tests. Runs in parallel across Node versions.
