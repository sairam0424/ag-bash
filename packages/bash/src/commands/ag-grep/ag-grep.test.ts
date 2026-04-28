import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { agGrepCommand } from "./ag-grep.js";

describe("ag-grep command", () => {
  let bash: Bash;

  beforeEach(async () => {
    bash = new Bash();
    await bash.fs.writeFile(
      "/test.txt",
      "Hello World\nThis is Ag-Bash\nTesting grep",
    );
    await bash.fs.mkdir("/src");
    await bash.fs.writeFile("/src/code.ts", "const x = 10;\nconsole.log(x);");
  });

  it("should find text in a single file", async () => {
    const result = await agGrepCommand.execute(["Hello", "/test.txt"], {
      fs: bash.fs,
      cwd: "/",
      env: new Map(),
      stdin: "",
      bash,
    } as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/test.txt:1:Hello World");
  });

  it("should search recursively in a directory", async () => {
    const result = await agGrepCommand.execute(["console", "/"], {
      fs: bash.fs,
      cwd: "/",
      env: new Map(),
      stdin: "",
      bash,
    } as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/src/code.ts:2:console.log(x);");
  });

  it("should respect ignore-case flag", async () => {
    const result = await agGrepCommand.execute(["hello", "--ignore-case"], {
      fs: bash.fs,
      cwd: "/",
      env: new Map(),
      stdin: "",
      bash,
    } as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/test.txt:1:Hello World");
  });

  it("should return error if no matches found", async () => {
    const result = await agGrepCommand.execute(["nonexistent", "/"], {
      fs: bash.fs,
      cwd: "/",
      env: new Map(),
      stdin: "",
      bash,
    } as any);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("No matches found.\n");
  });
});
