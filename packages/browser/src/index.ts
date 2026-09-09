import type { Bash } from "@ag-bash/bash";
import {
  BrowserCdpTool,
  BrowserClickTool,
  BrowserGotoTool,
  BrowserJsTool,
  BrowserPageInfoTool,
  BrowserPressTool,
  BrowserScreenshotTool,
  BrowserTypeTool,
  BrowserWaitForElementTool,
} from "./tools.js";

export {
  BROWSER_HARNESS_CONNECTION_ID,
  ensureBrowserHarnessConnection,
} from "./connection.js";
export {
  BrowserCdpTool,
  BrowserClickTool,
  BrowserGotoTool,
  BrowserJsTool,
  BrowserPageInfoTool,
  BrowserPressTool,
  BrowserScreenshotTool,
  BrowserTypeTool,
  BrowserWaitForElementTool,
};

const BROWSER_TOOLS = [
  BrowserGotoTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserPressTool,
  BrowserScreenshotTool,
  BrowserJsTool,
  BrowserCdpTool,
  BrowserWaitForElementTool,
  BrowserPageInfoTool,
] as const;

/**
 * Register the curated `ag_browser_*` tool suite onto a Bash instance's
 * toolbox. Once registered, the tools are usable both from bash scripts
 * (`bash.toolbox.callTool(bash, "ag_browser_goto", {...})`) and, if the
 * caller is an MCP server built on `bash.toolbox` (e.g.
 * @ag-bash/mcp-server's `McpToolBridge`), automatically surfaced as MCP
 * tools too — no MCP-server-side protocol code needed beyond calling this
 * function once at startup.
 */
export function registerBrowserTools(bash: Bash): void {
  for (const tool of BROWSER_TOOLS) {
    bash.toolbox.registerTool(tool);
  }
}
