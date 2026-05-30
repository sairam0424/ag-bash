# Agentic Tools

> Documentation coming in v5.0.

## Overview

Agentic tools provide AI-native capabilities for autonomous code editing, search, and project management within the ag-bash virtual filesystem.

### Commands

| Command | Description |
|---------|-------------|
| `ag-plan` | Plan-mode orchestration: enter/exit read-only mode and manage multi-step plans. |
| `ag-notebook` | Read, edit, and append cells in Jupyter Notebook (.ipynb) files. |
| `ag-convert` | Intelligent document and image-to-markdown conversion with AI vision. |
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
