import { describe, it, expect, beforeEach } from "vitest";
import { agEditCommand } from "./ag-edit.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import { CommandContext } from "../../types.js";

describe("ag-edit", () => {
  let fs: InMemoryFs;
  let ctx: CommandContext;

  beforeEach(() => {
    fs = new InMemoryFs({
      "test.txt": "line 1\nline 2\nline 3\n",
    });
    ctx = {
      fs,
      cwd: "/",
      env: new Map(),
      stdin: "",
    } as any;
  });

  it("should insert lines before a specific line", async () => {
    const result = await agEditCommand.execute(["insert-before", "test.txt", "-n", "2", "-x", "new line"], ctx);
    expect(result.exitCode).toBe(0);
    const content = await fs.readFile("/test.txt", "utf8");
    expect(content).toBe("line 1\nnew line\nline 2\nline 3\n");
  });

  it("should replace a range of lines", async () => {
    const result = await agEditCommand.execute(["replace", "test.txt", "-n", "1", "-t", "2", "-x", "replaced"], ctx);
    expect(result.exitCode).toBe(0);
    const content = await fs.readFile("/test.txt", "utf8");
    expect(content).toBe("replaced\nline 3\n");
  });

  it("should delete a range of lines", async () => {
    const result = await agEditCommand.execute(["delete", "test.txt", "-n", "2", "-t", "3"], ctx);
    expect(result.exitCode).toBe(0);
    const content = await fs.readFile("/test.txt", "utf8");
    expect(content).toBe("line 1\n");
  });

  it("should support dry-run mode", async () => {
    const result = await agEditCommand.execute(["append", "test.txt", "-x", "appended", "--dry-run"], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[DRY RUN]");
    const content = await fs.readFile("/test.txt", "utf8");
    expect(content).toBe("line 1\nline 2\nline 3\n");
  });

  it("should return error for invalid line numbers", async () => {
    const result = await agEditCommand.execute(["insert-before", "test.txt", "-n", "10", "-x", "fail"], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("out of range");
  });
});
