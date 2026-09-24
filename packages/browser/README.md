# @ag-bash/browser

Optional `ag_browser_*` tool suite for [Ag-Bash](https://github.com/sairam0424/ag-bash). It adds scripted, deterministic Chrome DevTools Protocol (CDP) automation — navigate, click, type, screenshot, evaluate JS, raw CDP, wait-for-element, page-info — by delegating to the [`browser-harness-mcp`](https://github.com/sairam0424/browser-harness) server over the existing `@ag-bash/bash` MCP client.

This is a *scripted automation* surface, not an autonomous `browser_use.Agent` integration: every tool maps 1:1 onto a single `browser-harness-mcp` tool and does exactly what its arguments say.

## Tools

| Tool | Description |
| --- | --- |
| `ag_browser_goto` | Navigate the current browser tab to a URL. |
| `ag_browser_click` | Click at screen coordinates in the current tab. |
| `ag_browser_type` | Insert text into the currently focused element. |
| `ag_browser_press` | Press a key (with optional modifiers) in the current tab. |
| `ag_browser_screenshot` | Capture a PNG screenshot of the current tab (viewport or full page). |
| `ag_browser_js` | Evaluate a JavaScript expression in the current tab. |
| `ag_browser_cdp` | Call a raw Chrome DevTools Protocol method (escape hatch). |
| `ag_browser_wait_for_element` | Wait for an element matching a CSS selector to appear. |
| `ag_browser_page_info` | Return current tab metadata: url, title, viewport and scroll sizes. |

Each tool lazily connects to `browser-harness-mcp` on first use (`uvx --from "browser-harness[mcp]" browser-harness-mcp`), sharing one connection per `Bash` instance. All tools except `ag_browser_screenshot`, `ag_browser_wait_for_element`, and `ag_browser_page_info` are marked destructive, so they are denied while a `Bash` instance is in `"plan"` mode.

## Installation

```bash
npm install @ag-bash/browser
```

It is an optional dependency of `@ag-bash/mcp-server`: if it is installed alongside the MCP server, its tools are loaded automatically at startup. If it is absent, the MCP server still starts normally without the `ag_browser_*` tools.

## Usage

```ts
import { Bash } from "@ag-bash/bash";
import { registerBrowserTools } from "@ag-bash/browser";

const bash = new Bash();
registerBrowserTools(bash);

const result = await bash.toolbox.callTool(bash, "ag_browser_goto", {
  url: "https://example.com",
});
console.log(result);
```

Once registered, the tools are also automatically surfaced over MCP by any host built on `bash.toolbox` (e.g. `@ag-bash/mcp-server`'s `McpToolBridge`) — no MCP-side protocol code is needed beyond calling `registerBrowserTools(bash)`.

## Requirements

`browser-harness-mcp` must be reachable on the host running these tools (installed via `uv tool install browser-harness[mcp]`, invoked as `uvx --from "browser-harness[mcp]" browser-harness-mcp`).

## License

Apache-2.0
