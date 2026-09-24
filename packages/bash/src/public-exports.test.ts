import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Bash, buildTool, type ToolboxTool } from "./index.js";

describe("public exports: agentic tool authoring surface", () => {
  it("exposes buildTool for downstream packages (e.g. @ag-bash/browser) to author ToolboxTool-conformant tools", async () => {
    expect(typeof buildTool).toBe("function");

    const tool: ToolboxTool<{ value: string }, string> = buildTool({
      name: "test_echo_tool",
      description: "Echoes its input",
      parameters: z.object({ value: z.string() }),
      execute: async (_bash: Bash, args) => args.value,
    });

    expect(tool.name).toBe("test_echo_tool");
    const bash = new Bash();
    expect(await tool.execute(bash, { value: "hi" })).toBe("hi");
  });
});
