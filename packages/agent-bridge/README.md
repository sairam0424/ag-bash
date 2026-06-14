# @ag-bash/agent-bridge

> Terminal UI bridge for AI agent communication with ag-bash

[![npm version](https://img.shields.io/npm/v/@ag-bash/agent-bridge?label=npm&color=cb3837)](https://www.npmjs.com/package/@ag-bash/agent-bridge)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Connects AI agents to terminal UIs (xterm.js, etc.) with streaming responses, tool call rendering, and pluggable adapter architecture.

## Installation

```bash
npm install @ag-bash/agent-bridge
```

## Quick Start

```typescript
import { createAgentBridge } from "@ag-bash/agent-bridge";
import { Bash } from "@ag-bash/bash";

const bash = new Bash({ agentic: { enabled: true } });

const bridge = createAgentBridge(terminal, {
  bash,
  apiEndpoint: "/api/agent",
});

// Run agent prompts through the bridge
await bridge.executeAgentPrompt("list all files in /src");

// Or register as a shell command
const bashWithAgent = new Bash({ customCommands: [bridge.agentCmd] });
await bashWithAgent.exec('agent "explain this codebase"');
```

## Adapter Pattern

Swap the backend without changing your UI code:

```typescript
import { FetchAgentAdapter } from "@ag-bash/agent-bridge";

// Built-in: SSE streaming over HTTP
const fetchAdapter = new FetchAgentAdapter("/api/agent");

// Custom: implement the AgentAdapter interface
const customAdapter: AgentAdapter = {
  type: "websocket",
  async *run(messages) {
    // yield streaming events
  },
};

createAgentBridge(terminal, { adapter: customAdapter });
```

## Features

- **Streaming rendering** — Text deltas, tool calls, and results stream to the terminal in real time
- **Tool call display** — Bash commands shown with `$` prefix; other tools shown by name
- **Pluggable adapters** — `FetchAgentAdapter` included; implement `AgentAdapter` for custom transports
- **Orchestrator mode** — Pass a `Bash` instance for local tool execution without a remote API
- **Error sanitization** — File paths and Node.js internals stripped from terminal output
- **Conversation state** — Message history managed automatically with reset support

## Links

- [GitHub Repository](https://github.com/AstroBaseCode/ag-bash)
- [Core Engine](https://www.npmjs.com/package/@ag-bash/bash)
- [MCP Server](https://www.npmjs.com/package/@ag-bash/mcp-server)

## License

Apache-2.0
