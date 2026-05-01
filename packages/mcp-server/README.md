# @ag-bash/mcp-server

A standalone Model Context Protocol (MCP) server that provides a persistent, sandboxed Bash environment to AI agents.

This server leverages the `@ag-bash/bash` engine to allow agents to execute shell commands, process data with `jq`, and run Python/JS scripts within a secure virtual filesystem.

---

## 🚀 Installation

Install the MCP server globally using npm:

```bash
npm install -g @ag-bash/mcp-server
```

## ⚙️ Configuration

To use Ag-Bash with your favorite AI client, add it to your `mcpConfig.json` or equivalent configuration file.

### Claude Desktop

On macOS, edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Add a new MCP server in your IDE settings with the following details:
- **Name**: `ag-bash`
- **Type**: `command`
- **Command**: `ag-bash-mcp`

---

## 🛠️ Available Tools

The server exports the following tools to the agent:

### 1. `run_bash`
Executes a bash script in the sandboxed environment.
- **Parameters**: 
    - `script` (string, required): The bash code to execute.
- **Features**: 
    - Automatically persists environment variables, functions, and CWD across calls.
    - Full access to `jq`, `grep`, `sed`, and other unix utilities.

### 2. `get_state`
Retrieves the current state of the shell session.
- **Returns**: 
    - Current working directory (`cwd`).
    - Active environment variables.
    - Defined functions.

### 3. `agentic_suite` (Nexus Prime)
Full access to the Nexus Prime toolset for high-fidelity code manipulation and analysis.
- **Tools**: `ag-hover`, `ag-explain`, `ag-find-symbol`, `ag-todo`, `ag-analyze`, `ag-edit`, `ag-diff`.
- **Features**: 
    - Semantic code intelligence.
    - Persistent task tracking.
    - Surgical file modifications.

---

## 🛡️ Security Features

- **Read-Only Root**: By default, the server mounts your current project root as a **Read-Only** overlay. Any changes made by the agent stay in the virtual memory and never touch your real files.
- **In-Process Sandbox**: No external VM required; execution is isolated using Ag-Bash's internal security logic.
- **Sanitized Errors (v3.0.0)**: JSON-RPC error messages strip file paths and cap at 200 characters to prevent information leakage.
- **Zero Console Leakage (v3.0.0)**: Library code never writes to `console.*` — all diagnostics flow through structured error handlers.
- **Resource Limits**: Protects against infinite loops, excessive memory, and session-wide network traffic accounting.
- **Orchestration Governance**: Enforces agent nesting limits to prevent recursive loops in multi-agent workflows.

## 📜 License

Apache-2.0
