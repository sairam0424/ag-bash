import { Bash } from "@ag-bash/bash";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_HARNESS_CONNECTION_ID } from "./connection.js";
import { registerBrowserTools } from "./index.js";

function fakeConnection() {
  return {
    id: BROWSER_HARNESS_CONNECTION_ID,
    name: BROWSER_HARNESS_CONNECTION_ID,
    type: "stdio" as const,
    status: "connected" as const,
    tools: [],
    transport: {
      init: vi.fn(),
      send: vi.fn(),
      notify: vi.fn(),
      close: vi.fn(),
    },
  };
}

const EXPECTED_TOOL_NAMES = [
  "ag_browser_goto",
  "ag_browser_click",
  "ag_browser_type",
  "ag_browser_press",
  "ag_browser_screenshot",
  "ag_browser_js",
  "ag_browser_cdp",
  "ag_browser_wait_for_element",
  "ag_browser_page_info",
];

describe("registerBrowserTools", () => {
  it("registers all nine ag_browser_* tools onto the toolbox", () => {
    const bash = new Bash();
    registerBrowserTools(bash);
    const tools = bash.toolbox.getAgenticTools(bash);
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(tools[name]).toBeDefined();
    }
  });

  it("routes a full toolbox call through to the browser-harness MCP connection", async () => {
    const bash = new Bash();
    registerBrowserTools(bash);
    vi.spyOn(bash.services.mcpClient, "listConnections").mockReturnValue([
      fakeConnection(),
    ]);
    vi.spyOn(bash.services.mcpClient, "callTool").mockResolvedValue({
      content: [{ type: "text", text: '{"url":"https://example.com"}' }],
    });

    const result = await bash.toolbox.callTool(
      bash,
      "ag_browser_page_info",
      {},
    );

    expect(result).toBe(
      JSON.stringify(
        { content: [{ type: "text", text: '{"url":"https://example.com"}' }] },
        null,
        2,
      ),
    );
  });

  it("denies ag_browser_click in plan mode via the full toolbox lifecycle", async () => {
    const bash = new Bash();
    registerBrowserTools(bash);
    bash.setMode("plan");

    const result = await bash.toolbox.callTool(bash, "ag_browser_click", {
      x: 1,
      y: 2,
    });

    expect(result).toBe(
      "Permission Denied: Cannot execute destructive tool 'ag_browser_click' in plan mode.",
    );
  });
});
