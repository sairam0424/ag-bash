import { describe, expect, it, vi } from "vitest";
import { AgBashServer } from "./index.js";

describe("optional @ag-bash/browser loading", () => {
  it("registers ag_browser_* tools when @ag-bash/browser resolves", async () => {
    const registerBrowserTools = vi.fn();
    const server = new AgBashServer(async () => ({ registerBrowserTools }));

    await server.loadOptionalPackages();

    expect(registerBrowserTools).toHaveBeenCalledTimes(1);
  });

  it("starts normally when @ag-bash/browser is absent", async () => {
    const server = new AgBashServer(async () => {
      throw new Error("Cannot find package '@ag-bash/browser'");
    });

    await expect(server.loadOptionalPackages()).resolves.toBeUndefined();
  });
});
