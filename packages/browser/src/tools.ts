import { buildTool, type ToolboxTool } from "@ag-bash/bash";
import { z } from "zod";
import {
  BROWSER_HARNESS_CONNECTION_ID,
  ensureBrowserHarnessConnection,
} from "./connection.js";

/**
 * Shared empty-shape constant for no-argument tool schemas, matching the
 * `EMPTY_SHAPE` convention in packages/bash/src/agentic/toolbox/registry.ts
 * — avoids the banned `{}` object literal (prototype-pollution guard).
 */
const EMPTY_SHAPE: Record<string, never> = Object.create(null);

/**
 * Format a raw MCP tools/call result the same way McpToolBridge.callTool
 * formats its own generic passthrough tools: strings pass through,
 * everything else is pretty-printed JSON.
 */
function formatMcpResult(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

interface BrowserToolSpec<TArgs extends Record<string, unknown>> {
  name: string;
  harnessTool: string;
  description: string;
  parameters: z.ZodType<TArgs>;
  isReadOnly: boolean;
  isDestructive: boolean;
}

/**
 * Build one ag_browser_* tool that delegates to a single browser-harness-mcp
 * tool. `checkPermissions` is intentionally omitted so buildTool's default
 * (deny destructive tools while `bash.getMode() === "plan"`) applies —
 * matching the convention in packages/bash/src/agentic/EditTool.ts.
 */
function buildBrowserTool<TArgs extends Record<string, unknown>>(
  spec: BrowserToolSpec<TArgs>,
): ToolboxTool<TArgs, string> {
  return buildTool<TArgs, string>({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    isReadOnly: spec.isReadOnly,
    isDestructive: spec.isDestructive,
    execute: async (bash, args) => {
      await ensureBrowserHarnessConnection(bash);
      const result = await bash.services.mcpClient.callTool(
        BROWSER_HARNESS_CONNECTION_ID,
        spec.harnessTool,
        args,
        bash,
      );
      return formatMcpResult(result);
    },
  });
}

interface GotoArgs extends Record<string, unknown> {
  url: string;
}
export const BrowserGotoTool: ToolboxTool<GotoArgs, string> = buildBrowserTool({
  name: "ag_browser_goto",
  harnessTool: "browser_goto",
  description: "Navigate the current browser tab to a URL (browser-harness).",
  parameters: z.object({
    url: z.string().describe("The URL to navigate the current tab to."),
  }),
  isReadOnly: false,
  isDestructive: true,
});

interface ClickArgs extends Record<string, unknown> {
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  clicks?: number;
}
export const BrowserClickTool: ToolboxTool<ClickArgs, string> =
  buildBrowserTool({
    name: "ag_browser_click",
    harnessTool: "browser_click",
    description:
      "Click at screen coordinates in the current browser tab (browser-harness).",
    parameters: z.object({
      x: z
        .number()
        .int()
        .describe("X screen coordinate to click, in viewport pixels."),
      y: z
        .number()
        .int()
        .describe("Y screen coordinate to click, in viewport pixels."),
      button: z
        .enum(["left", "right", "middle"])
        .optional()
        .describe("Mouse button to click. Defaults to 'left'."),
      clicks: z
        .number()
        .int()
        .optional()
        .describe("Number of clicks (2 for double-click). Defaults to 1."),
    }),
    isReadOnly: false,
    isDestructive: true,
  });

interface TypeArgs extends Record<string, unknown> {
  text: string;
}
export const BrowserTypeTool: ToolboxTool<TypeArgs, string> = buildBrowserTool({
  name: "ag_browser_type",
  harnessTool: "browser_type",
  description:
    "Insert text into the currently focused element (browser-harness).",
  parameters: z.object({
    text: z
      .string()
      .describe("Text to insert into the currently focused element."),
  }),
  isReadOnly: false,
  isDestructive: true,
});

interface PressArgs extends Record<string, unknown> {
  key: string;
  modifiers?: number;
}
export const BrowserPressTool: ToolboxTool<PressArgs, string> =
  buildBrowserTool({
    name: "ag_browser_press",
    harnessTool: "browser_press",
    description: "Press a key in the current browser tab (browser-harness).",
    parameters: z.object({
      key: z
        .string()
        .describe("Key to press, e.g. 'Enter', 'Tab', 'ArrowDown'."),
      modifiers: z
        .number()
        .int()
        .optional()
        .describe(
          "Modifier bitfield: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift. Combine by summing. Defaults to 0.",
        ),
    }),
    isReadOnly: false,
    isDestructive: true,
  });

interface ScreenshotArgs extends Record<string, unknown> {
  full?: boolean;
  max_dim?: number;
  path?: string;
}
export const BrowserScreenshotTool: ToolboxTool<ScreenshotArgs, string> =
  buildBrowserTool({
    name: "ag_browser_screenshot",
    harnessTool: "browser_screenshot",
    description:
      "Capture a PNG screenshot of the current browser tab (browser-harness).",
    parameters: z.object({
      full: z
        .boolean()
        .optional()
        .describe(
          "Capture the full scrollable page instead of the viewport. Defaults to false.",
        ),
      max_dim: z
        .number()
        .int()
        .optional()
        .describe("Downscale the result if larger than this pixel dimension."),
      path: z
        .string()
        .optional()
        .describe(
          "Filesystem path to save the PNG to. A temp file is used if omitted.",
        ),
    }),
    isReadOnly: true,
    isDestructive: false,
  });

interface JsArgs extends Record<string, unknown> {
  expression: string;
  target_id?: string;
}
export const BrowserJsTool: ToolboxTool<JsArgs, string> = buildBrowserTool({
  name: "ag_browser_js",
  harnessTool: "browser_js",
  description:
    "Evaluate a JavaScript expression in the current browser tab (browser-harness).",
  parameters: z.object({
    expression: z
      .string()
      .describe("JavaScript expression to evaluate in the current tab."),
    target_id: z
      .string()
      .optional()
      .describe(
        "Iframe target id to evaluate in, instead of the top-level frame.",
      ),
  }),
  isReadOnly: false,
  isDestructive: true,
});

interface CdpArgs extends Record<string, unknown> {
  method: string;
  params?: Record<string, unknown>;
}
export const BrowserCdpTool: ToolboxTool<CdpArgs, string> = buildBrowserTool({
  name: "ag_browser_cdp",
  harnessTool: "browser_cdp",
  description:
    "Call a raw Chrome DevTools Protocol method (browser-harness escape hatch).",
  parameters: z.object({
    method: z
      .string()
      .describe("Raw Chrome DevTools Protocol method, e.g. 'DOM.getBoxModel'."),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Parameters for the CDP method, passed through as-is."),
  }),
  isReadOnly: false,
  isDestructive: true,
});

interface WaitForElementArgs extends Record<string, unknown> {
  selector: string;
  timeout?: number;
  visible?: boolean;
}
export const BrowserWaitForElementTool: ToolboxTool<
  WaitForElementArgs,
  string
> = buildBrowserTool({
  name: "ag_browser_wait_for_element",
  harnessTool: "browser_wait_for_element",
  description:
    "Wait for an element matching a CSS selector to appear (browser-harness).",
  parameters: z.object({
    selector: z.string().describe("CSS selector of the element to wait for."),
    timeout: z
      .number()
      .optional()
      .describe("Maximum seconds to wait before giving up. Defaults to 10."),
    visible: z
      .boolean()
      .optional()
      .describe(
        "Also require the element to be rendered (not just present in the DOM). Defaults to false.",
      ),
  }),
  isReadOnly: true,
  isDestructive: false,
});

type PageInfoArgs = Record<string, unknown>;
export const BrowserPageInfoTool: ToolboxTool<PageInfoArgs, string> =
  buildBrowserTool<PageInfoArgs>({
    name: "ag_browser_page_info",
    harnessTool: "browser_page_info",
    description:
      "Return current tab metadata: url, title, viewport and scroll sizes (browser-harness).",
    parameters: z.object(EMPTY_SHAPE),
    isReadOnly: true,
    isDestructive: false,
  });
