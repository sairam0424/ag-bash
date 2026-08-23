# Agentic Tools

> Documentation coming in v5.0.

## Overview

Agentic tools provide AI-native capabilities for autonomous code editing, search, and project management within the ag-bash virtual filesystem. **`ag-convert` is the one exception** — it delegates to a host `python3` process and therefore needs a real host path, not a VFS-only one (see below).

### Commands

| Command | Description |
|---------|-------------|
| `ag-plan` | Plan-mode orchestration: enter/exit plan mode and manage multi-step plans (`enter`, `exit`, `status`, `add`, `list`). ⚠️ Blocks destructive *commands* only — a shell redirection (`echo x > f`) bypasses it. Not a security boundary; see `THREAT_MODEL.md` TB7. |
| `ag-notebook` | Read, edit, and append cells in Jupyter Notebook (.ipynb) files. |
| `ag-convert` | Intelligent document and image-to-markdown conversion with AI vision. ⚠️ Spawns **host** `python3` (`spawnSync`) with the full parent environment; it is **not** run in the CPython WASM sandbox that the `python3` builtin uses. Registered by default. Fails closed on paths that exist only in the VFS. See `THREAT_MODEL.md` TB8. |
| `ag-grep` | High-performance recursive pattern search across the virtual filesystem. |
| `ag-find-files` | High-performance recursive file search by name pattern. |
| `ag-glob` | Fast glob pattern matching over the virtual filesystem. |
| `ag-worktree` | Manage isolated virtual worktrees for parallel development. |

## Usage

```bash
# Search for a pattern across all files
ag-grep "TODO" --include="*.ts"

# Find files by name pattern
ag-find-files "*.test.ts"

# Enter plan mode (read-only until plan is approved)
ag-plan enter "refactor auth module"

# Manage worktrees for parallel work
ag-worktree create feature-branch
ag-worktree list
```

## Integration with RunLoop

These tools are automatically registered with the RunLoop's tool registry and receive MCP tool annotations (`readOnlyHint`, `destructiveHint`) for safe parallel execution.
