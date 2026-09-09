import { Bash } from "@ag-bash/bash";
import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_HARNESS_CONNECTION_ID,
  ensureBrowserHarnessConnection,
} from "./connection.js";

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

describe("ensureBrowserHarnessConnection", () => {
  it("connects with the documented browser-harness-mcp stdio invocation", async () => {
    const bash = new Bash();
    vi.spyOn(bash.services.mcpClient, "listConnections").mockReturnValue([]);
    const connectStdio = vi
      .spyOn(bash.services.mcpClient, "connectStdio")
      .mockResolvedValue(fakeConnection());

    await ensureBrowserHarnessConnection(bash);

    expect(connectStdio).toHaveBeenCalledWith(
      "browser-harness",
      "uvx",
      ["--from", "browser-harness[mcp]", "browser-harness-mcp"],
      expect.objectContaining({ bash }),
      { requestTimeoutMs: 60_000 },
    );
  });

  it("reuses an existing connection instead of reconnecting", async () => {
    const bash = new Bash();
    vi.spyOn(bash.services.mcpClient, "listConnections").mockReturnValue([
      fakeConnection(),
    ]);
    const connectStdio = vi.spyOn(bash.services.mcpClient, "connectStdio");

    await ensureBrowserHarnessConnection(bash);

    expect(connectStdio).not.toHaveBeenCalled();
  });

  it("shares one in-flight connection across concurrent callers", async () => {
    const bash = new Bash();
    vi.spyOn(bash.services.mcpClient, "listConnections").mockReturnValue([]);
    let resolveConnect: (value: ReturnType<typeof fakeConnection>) => void =
      () => {};
    const connectStdio = vi
      .spyOn(bash.services.mcpClient, "connectStdio")
      .mockReturnValue(
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
      );

    const first = ensureBrowserHarnessConnection(bash);
    const second = ensureBrowserHarnessConnection(bash);
    resolveConnect(fakeConnection());
    await Promise.all([first, second]);

    expect(connectStdio).toHaveBeenCalledTimes(1);
  });
});
