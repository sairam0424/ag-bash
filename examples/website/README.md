# ag-bash website at 

This is an interactive demo of **ag-bash** running entirely in your browser, with an AI agent that can explore the source code.

## Architecture

```
+----------------------------------------------------------+
|                        BROWSER                           |
|  +----------+    +----------+    +----------------+      |
|  | xterm.js |--->| ag-bash|--->| Virtual FS     |      |
|  | Terminal |    | (browser)|    | (in-memory)    |      |
|  +----------+    +----------+    +----------------+      |
|       |                                                  |
|       | `agent` command                                  |
|       v                                                  |
|  +--------------------------------------------------+   |
|  |          SSE Stream (Server-Sent Events)         |   |
|  +--------------------------------------------------+   |
+----------------------------|-----------------------------+
                             |
                             v
+----------------------------------------------------------+
|                        SERVER                            |
|  +-------------+    +----------+    +----------------+   |
|  |ToolLoopAgent|--->| bash-tool|--->| ag-bash      |   |
|  | (AI SDK)    |    |          |    | + OverlayFS    |   |
|  |Claude Haiku |    | - bash   |    |                |   |
|  +-------------+    | - read   |    | Real files:    |   |
|                     | - write  |    | - ag-bash/   |   |
|                     +----------+    | - bash-tool/   |   |
|                                     +----------------+   |
+----------------------------------------------------------+
```

## Components

### 1. ag-bash (Browser)
- Pure TypeScript bash interpreter
- Runs locally in browser for regular commands
- In-memory virtual filesystem with pre-loaded files
- No network calls for basic commands like `ls`, `cat`, `grep`

### 2. xterm.js (Browser Terminal)
- Renders a real terminal in the browser
- Handles keyboard input, cursor, colors, scrolling
- Supports ANSI escape codes for styling

### 3. `agent` Command
- Custom command that calls the server
- Sends conversation history to `/api/agent`
- Streams response via Server-Sent Events (SSE)
- Displays tool calls (bash commands, file reads) in real-time

### 4. ToolLoopAgent (Server - AI SDK)
- Uses Anthropic's Claude Haiku model
- Loops automatically: think -> tool call -> observe -> think -> ...
- Stops after 20 tool calls or when done
- Streams responses back to browser

### 5. bash-tool (Server)
- Provides tools for the AI agent:
  - `bash` - Execute bash commands
  - `readFile` - Read file contents
  - `writeFile` - Write files (disabled in this demo)
- Integrates with ag-bash sandbox

### 6. OverlayFS (Server)
- Overlays real filesystem (this source code) as read-only
- Agent can explore ag-bash and bash-tool source
- Writes go to memory, not disk

## Data Flow

1. You type `agent "how does grep work?"`
2. Browser ag-bash runs the `agent` command
3. Command POSTs to `/api/agent` with message history
4. Server creates ToolLoopAgent with bash-tool
5. Agent thinks, calls tools (bash, readFile), observes results
6. Each step streams back as SSE events
7. Browser displays tool calls and final response
8. Response added to conversation history for multi-turn chat

## Development

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to see the terminal.

## Links

- **ag-bash**: https://github.com/ag-ai/ag-bash-cli
- **bash-tool**: https://github.com/ag-ai/bash-tool
- **AI SDK**: https://ai-sdk.dev
- **xterm.js**: https://xtermjs.org
