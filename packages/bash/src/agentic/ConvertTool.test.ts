import { describe, it, expect, beforeEach, vi } from "vitest";
import { Bash } from "../Bash.js";
import { ConvertTool } from "./ConvertTool.js";
import { agConvertCommand } from "../commands/ag-convert/ag-convert.js";

describe("ConvertTool", () => {
  let bash: Bash;

  beforeEach(() => {
    bash = new Bash();
    // Mock agConvertCommand.execute to avoid calling python
    vi.spyOn(agConvertCommand, "execute").mockResolvedValue({
      stdout: "Converted Markdown Content",
      stderr: "",
      exitCode: 0,
      env: {},
    });
  });

  it("should execute conversion with correct arguments", async () => {
    const result = await ConvertTool.execute(bash, {
      filePath: "test.pdf",
      engine: "docling",
      highFidelity: true,
    });

    expect(agConvertCommand.execute).toHaveBeenCalledWith(
      ["test.pdf", "--engine", "docling", "--high-fidelity"],
      expect.any(Object)
    );
    expect(result).toBe("Converted Markdown Content");
  });

  it("should handle conversion errors", async () => {
    vi.spyOn(agConvertCommand, "execute").mockResolvedValue({
      stdout: "",
      stderr: "File not found",
      exitCode: 1,
      env: {},
    });

    await expect(ConvertTool.execute(bash, { filePath: "missing.pdf" }))
      .rejects.toThrow("File not found");
  });

  it("should have correct metadata", () => {
    expect(ConvertTool.name).toBe("ag_convert");
    expect(ConvertTool.effort).toBe("high");
  });
});
