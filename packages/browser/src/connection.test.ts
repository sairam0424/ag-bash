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

  it("retries on the next call after a failed connect attempt", async () => {
    const bash = new Bash();
    vi.spyOn(bash.services.mcpClient, "listConnections").mockReturnValue([]);
    const connectStdio = vi
      .spyOn(bash.services.mcpClient, "connectStdio")
      .mockRejectedValueOnce(new Error("uvx cold-start timeout"))
      .mockResolvedValueOnce(fakeConnection());

    await expect(ensureBrowserHarnessConnection(bash)).rejects.toThrow(
      "uvx cold-start timeout",
    );

    // A second call must not replay the cached rejection forever — it
    // should attempt a fresh connectStdio and succeed.
    await expect(ensureBrowserHarnessConnection(bash)).resolves.toBeUndefined();
    expect(connectStdio).toHaveBeenCalledTimes(2);
  });

  it("propagates a connect failure to all concurrent callers sharing the in-flight attempt", async () => {
    const bash = new Bash();
    vi.spyOn(bash.services.mcpClient, "listConnections").mockReturnValue([]);
    let rejectConnect: (error: unknown) => void = () => {};
    vi.spyOn(bash.services.mcpClient, "connectStdio").mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectConnect = reject;
      }),
    );

    const first = ensureBrowserHarnessConnection(bash);
    const second = ensureBrowserHarnessConnection(bash);
    rejectConnect(new Error("network hiccup"));

    await expect(first).rejects.toThrow("network hiccup");
    await expect(second).rejects.toThrow("network hiccup");
  });
});
