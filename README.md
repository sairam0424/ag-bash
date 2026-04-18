# Ag-Bash: The AI-Native Shell Monorepo

[![NPM Version](https://img.shields.io/npm/v/@ag-bash/bash.svg)](https://www.npmjs.com/package/@ag-bash/bash)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/sairam0424/ag-bash/blob/main/LICENSE)

Ag-Bash is a production-grade, sandboxed Bash environment designed specifically for AI agents. It provides a virtualized Unix-like experience entirely in-process, featuring an in-memory filesystem, integrated runtimes for Python and JavaScript, and full support for modern agentic protocols.

## 🏗️ Monorepo Architecture

This repository is organized into a modular monorepo to support independent versioning and consumption of core engine components and protocol adapters.

| Package | Version | Description |
|---|---|---|
| [`@ag-bash/bash`](./packages/bash) | `v1.3.0` | **Core Engine**: The virtual shell, filesystem, and sandboxed runtimes. |
| [`@ag-bash/mcp-server`](./packages/mcp-server) | `v1.3.0` | **MCP Server**: A standalone Model Context Protocol server for seamless agent integration. |

---

## 🚀 Quick Start

### For Developers (Library)

If you are building an application and want to embed a sandboxed shell:

```bash
npm install @ag-bash/bash
```

```typescript
import { Bash } from "@ag-bash/bash";

const bash = new Bash();
const result = await bash.exec('echo "Hello Ag-Bash"');
console.log(result.stdout); // "Hello Ag-Bash\n"
```

### 2. Standalone CLI & Shell (Global)

For human-in-the-loop debugging and interactive use, install the Ag-Bash suite globally.

#### Via Homebrew (macOS)
```bash
brew tap ag-bash/homebrew-tap
brew install ag-bash
```

#### Via NPM (Cross-platform)
```bash
npm install -g @ag-bash/bash @ag-bash/mcp-server
```

---

### For AI Agents (MCP)

To provide a bash environment to your agent (e.g., in Claude Desktop or Cursor):

```bash
npm install -g @ag-bash/mcp-server
```

Then, add the server to your MCP configuration:

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

---

## 🛡️ Key Features

- **Virtual Filesystem**: Choose between `InMemoryFs`, `OverlayFs` (COW), or `ReadWriteFs`.
- **Integrated Runtimes**: Out-of-the-box support for `jq`, `sqlite3`, `python3` (WASM), and `js-exec` (QuickJS).
- **Protocol First**: Full Model Context Protocol (MCP) support with persistent session state.
- **Defense in Depth**: Robust sandbox prevents prototype pollution and unauthorized filesystem access.
- **No Dependencies**: The core engine is lightweight and runs in Node.js or the Browser.

## 📖 Documentation

- **[Shell Engine Guide](./packages/bash/README.md)**: Deep dive into shell features, custom commands, and filesystem options.
- **[MCP Protocol Guide](./packages/mcp-server/README.md)**: Configuration and usage for agentic frameworks.
- **[Security Architecture](./THREAT_MODEL.md)**: Detailed breakdown of the sandbox and thread model.

## 📜 License

Apache-2.0
