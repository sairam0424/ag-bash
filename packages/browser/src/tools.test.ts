import { Bash } from "@ag-bash/bash";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_HARNESS_CONNECTION_ID } from "./connection.js";
import {
  BrowserClickTool,
  BrowserGotoTool,
  BrowserPageInfoTool,
} from "./tools.js";

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

describe("ag_browser_* tool definitions", () => {
  it("ag_browser_goto delegates to the browser-harness browser_goto tool", async () => {
    const bash = new Bash();
    vi.spyOn(bash.services.mcpClient, "listConnections").mockReturnValue([
      fakeConnection(),
    ]);
    const callTool = vi
      .spyOn(bash.services.mcpClient, "callTool")
      .mockResolvedValue({ content: [{ type: "text", text: "navigated" }] });

    const result = await BrowserGotoTool.execute(bash, {
      url: "https://example.com",
    });

    expect(callTool).toHaveBeenCalledWith(
      BROWSER_HARNESS_CONNECTION_ID,
      "browser_goto",
      { url: "https://example.com" },
      bash,
    );
    expect(result).toBe(
      JSON.stringify(
        { content: [{ type: "text", text: "navigated" }] },
        null,
        2,
      ),
    );
  });

  it("ag_browser_click is destructive and denied in plan mode", async () => {
    const bash = new Bash();
    bash.setMode("plan");
    const permission = await BrowserClickTool.checkPermissions(bash, {
      x: 10,
      y: 20,
    });
    expect(permission.behavior).toBe("deny");
  });

  it("ag_browser_page_info is read-only and allowed in plan mode", async () => {
    const bash = new Bash();
    bash.setMode("plan");
    const permission = await BrowserPageInfoTool.checkPermissions(bash, {});
    expect(permission.behavior).toBe("allow");
  });
});
