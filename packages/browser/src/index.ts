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

/**
 * Register the curated `ag_browser_*` tool suite onto a Bash instance's
 * toolbox. Once registered, the tools are usable both from bash scripts
 * (`bash.toolbox.callTool(bash, "ag_browser_goto", {...})`) and, if the
 * caller is an MCP server built on `bash.toolbox` (e.g.
 * @ag-bash/mcp-server's `McpToolBridge`), automatically surfaced as MCP
 * tools too — no MCP-server-side protocol code needed beyond calling this
 * function once at startup.
 *
 * Registered via nine explicit calls rather than a loop over an array: each
 * tool has a distinct `ToolboxTool<TArgs, TResult>` shape, and iterating a
 * heterogeneous `as const` tuple widens the loop variable to a union type
 * that defeats `registerTool<TArgs>`'s per-call generic inference (tsc
 * unifies against the wrong arm of the union). Explicit calls keep each
 * tool's own concrete type intact with no cast.
 */
export function registerBrowserTools(bash: Bash): void {
  bash.toolbox.registerTool(BrowserGotoTool);
  bash.toolbox.registerTool(BrowserClickTool);
  bash.toolbox.registerTool(BrowserTypeTool);
  bash.toolbox.registerTool(BrowserPressTool);
  bash.toolbox.registerTool(BrowserScreenshotTool);
  bash.toolbox.registerTool(BrowserJsTool);
  bash.toolbox.registerTool(BrowserCdpTool);
  bash.toolbox.registerTool(BrowserWaitForElementTool);
  bash.toolbox.registerTool(BrowserPageInfoTool);
}
