import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import type { CommandContext } from "../../types.js";
import { agDiffCommand } from "./ag-diff.js";

describe("ag-diff", () => {
  let fs: InMemoryFs;
  let ctx: CommandContext;

  beforeEach(() => {
    fs = new InMemoryFs({
      "f1.txt": "line 1\nline 2\n",
      "f2.txt": "line 1\nline 2\nline 3\n",
    });
    ctx = {
      fs,
      cwd: "/",
      env: new Map(),
      stdin: "",
    } as any;
  });

  it("should show diff between two files", async () => {
    const result = await agDiffCommand.execute(["f1.txt", "f2.txt"], ctx);
    expect(result.stdout).toContain("--- ag-diff summary ---");
    expect(result.stdout).toContain("Additions: 1");
    expect(result.stdout).toContain("+line 3");
  });

  it("should return exitCode 0 if no diff", async () => {
    const result = await agDiffCommand.execute(["f1.txt", "f1.txt"], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Additions: 0, Deletions: 0");
  });
});
