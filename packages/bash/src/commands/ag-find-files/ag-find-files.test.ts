import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { agFindFilesCommand } from "./ag-find-files.js";

describe("ag-find-files command", () => {
  let bash: Bash;

  beforeEach(async () => {
    bash = new Bash();
    await bash.fs.mkdir("/src");
    await bash.fs.writeFile("/src/app.ts", "");
    await bash.fs.writeFile("/README.md", "");
  });

  it("should find a file by name", async () => {
    const result = await agFindFilesCommand.execute(["app", "/"], {
      fs: bash.fs,
      cwd: "/",
      env: new Map(),
      stdin: "",
      bash,
    } as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/src/app.ts");
  });

  it("should return error if no matching files found", async () => {
    const result = await agFindFilesCommand.execute(["nonexistent", "/"], {
      fs: bash.fs,
      cwd: "/",
      env: new Map(),
      stdin: "",
      bash,
    } as any);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("No matching files found.\n");
  });
});
