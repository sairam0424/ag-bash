import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Bash } from "../Bash.js";
import { buildTool } from "./Tool.js";

describe("Unified Tooling Architecture", () => {
  it("should validate input using Zod schema", async () => {
    const tool = buildTool({
      name: "test_tool",
      description: "A test tool",
      parameters: z.object({
        foo: z.string(),
      }),
      execute: async (_bash, args) => `Hello ${args.foo}`,
    });

    const validResult = await tool.validateInput({ foo: "world" });
    expect(validResult.result).toBe(true);

    const invalidResult = await tool.validateInput({ foo: 123 });
    expect(invalidResult.result).toBe(false);
    if (invalidResult.result === false) {
      expect(invalidResult.message.toLowerCase()).toContain(
        "expected string, received number",
      );
    }
  });

  it("should enforce destructive tool restrictions in plan mode", async () => {
    const bash = new Bash();
    bash.setMode("plan");

    const tool = buildTool({
      name: "destructive_tool",
      description: "Destroys things",
      parameters: z.object({}),
      isDestructive: true,
      execute: async () => "Destroyed!",
    });

    const result = await tool.checkPermissions(bash, {});
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain(
        "Cannot execute destructive tool 'destructive_tool' in plan mode",
      );
    }

    // Should allow in execute mode
    bash.setMode("execute");
    const actResult = await tool.checkPermissions(bash, {});
    expect(actResult.behavior).toBe("allow");
  });
});
