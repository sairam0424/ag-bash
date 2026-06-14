# Migration Guide

## Migrating from v4.x to v5.0

### Breaking Changes

#### 1. DefenseInDepthBox defaults to enabled

Previously, calling `DefenseInDepthBox.getInstance()` without a config returned a disabled instance. Now it defaults to enabled (fail-closed).

**Before**: `resolveConfig(undefined)` → `{ enabled: false }`
**After**: `resolveConfig(undefined)` → `{ enabled: true }`
**Fix**: Explicitly pass `{ enabled: false }` if you need to disable.

#### 2. ServiceContainer uses lazy initialization

Services are no longer created eagerly. They initialize on first access. This means constructor side effects that depended on initialization order may need adjustment.

**Impact**: If you accessed `services.agentManager` in a timing-sensitive way during construction, the timing has changed.

#### 3. CommandContext.bash is now typed as BashHost

Previously `any`, now a narrow interface. Commands accessing undeclared methods will get type errors.

**Fix**: Use the `BashHost` interface methods, or cast to `Bash` if you need the full class.

#### 4. BashSnapshot.fs is now typed as FileSystemSnapshot

Previously `unknown`. If you were using type assertions, update them.

#### 5. MCP Server per-session isolation

The MCP server now creates isolated Bash instances per session instead of sharing one.

#### 6. Browser bundle split

The `@ag-bash/bash/browser` export now includes ALL dependencies (2.3MB).
For a lighter bundle (~400KB), use `@ag-bash/bash/browser-core` which externalizes heavy deps.

### New Features in v5.0

- `Symbol.asyncDispose` support (`await using bash = new Bash(...)`)
- Parallel tool execution in RunLoop (read-only tools)
- SharedStateBus resource limits
- MCP tool annotations (readOnlyHint, destructiveHint)
- Lazy service initialization (faster startup)
