# @ag-bash/mcp-server

> MCP server exposing 70 ag-bash tools to Claude Desktop and other MCP hosts

[![npm version](https://img.shields.io/npm/v/@ag-bash/mcp-server?label=npm&color=cb3837)](https://www.npmjs.com/package/@ag-bash/mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.sairam0424%2Fag--bash-blue)](https://registry.modelcontextprotocol.io)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A standalone Model Context Protocol (MCP) server that gives AI agents a persistent, sandboxed Bash environment, exposing **70 tools** over stdio.

## Installation

Add the server to Claude Code in one line:

```bash
claude mcp add ag-bash -- npx -y @ag-bash/mcp-server
```

Or install it globally:

```bash
npm install -g @ag-bash/mcp-server
```

### Claude Code plugin

Install via the self-hosted marketplace:

```
/plugin marketplace add sairam0424/ag-bash
/plugin install ag-bash@ag-bash
```

### MCP Registry

Listed as **`io.github.sairam0424/ag-bash`** (active) at [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io).

**Also available via:** Homebrew (`ag-bash-mcp` bin) · Docker MCP Catalog (in review)

```bash
brew tap sairam0424/tap && brew install ag-bash
```

## Usage

Run the server directly:

```bash
npx ag-bash-mcp
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ag-bash": {
      "command": "ag-bash-mcp",
      "args": []
    }
  }
}
```

### Cursor / VS Code

Add a new MCP server in your IDE settings:
- **Name**: `ag-bash`
- **Type**: `command`
- **Command**: `ag-bash-mcp`

## What's Exposed

- **`run_bash`** — Execute scripts with full unix toolkit (`jq`, `grep`, `sed`, `awk`, etc.)
- **`get_state`** — Inspect CWD, environment variables, and defined functions
- **Agentic suite** — `ag-edit`, `ag-diff`, `ag-hover`, `ag-explain`, `ag-find-symbol`, `ag-todo`, `ag-analyze`, `ag-snapshot`, `ag-plan`, `ag-notebook`, `ag-mcp`
- **70 tools total** via JSON-RPC 2.0 with Zod schema validation on every input

## Features

- **Rate limiting** — 60 requests/minute per session (configurable)
- **Read-only root** — Project files mounted as overlay; writes stay in memory
- **Sanitized errors** — JSON-RPC responses strip file paths, capped at 200 chars
- **Zero console leakage** — All diagnostics flow through structured handlers
- **Resource limits** — Protection against infinite loops and excessive memory
- **Orchestration governance** — Agent nesting limits prevent recursive loops

## v4.1 Upgrade Notes

| Before (v3.x) | After (v4.1) |
|---|---|
| 6 tools | 40+ tools |
| Basic bash execution | Full agentic suite with semantic code intelligence |
| Manual state management | Persistent environment across calls |

## Links

- [GitHub Repository](https://github.com/sairam0424/ag-bash)
- [Core Engine](https://www.npmjs.com/package/@ag-bash/bash)
- [MCP Registry](https://registry.modelcontextprotocol.io) — `io.github.sairam0424/ag-bash`

## License

Apache-2.0
