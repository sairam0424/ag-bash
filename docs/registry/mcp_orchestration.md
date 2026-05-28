# MCP and Orchestration Commands

> Documentation coming in v5.0.

## Overview

This section covers the MCP (Model Context Protocol) integration commands that enable multi-agent orchestration within ag-bash.

### Commands

| Command | Description |
|---------|-------------|
| `ag-mcp` | Connect to MCP servers, list tools, and invoke remote tool calls. |
| `ag-spawn` | Start a sub-agent in the background with a given command. |

## Usage

```bash
# List available MCP tools from a connected server
ag-mcp list-tools

# Invoke a remote tool call
ag-mcp call <tool-name> --arg key=value

# Spawn a background agent
ag-spawn "analyze the codebase for security issues"
```

## Configuration

MCP server connections are configured via the `mcpServers` option in Bash initialization or via `ag-mcp connect`.

See the [Agent Runtime docs](../agent-runtime.md) for integration with the RunLoop.
