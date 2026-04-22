import { describe, it, expect, beforeEach } from "vitest";
import { Bash } from "./Bash.js";
import { createAgenticTools } from "./agentic-tools.js";
import { InMemoryFs } from "./fs/in-memory-fs/index.js";

describe("Agentic Tools", () => {
  let bash: Bash;
  let tools: any;

  beforeEach(() => {
    bash = new Bash({
      parserEngine: 'legacy',
      fs: new InMemoryFs({
        "/test.txt": "hello world",
      }),
    });
    tools = createAgenticTools(bash);
  });

  describe("read_file", () => {
    it("should read a file and update fileState", async () => {
      const result = await tools.read_file.execute({ path: "/test.txt" });
      expect(result.content).toBe("hello world");
      expect(bash.fileState.has("/test.txt")).toBe(true);
      expect(bash.fileState.get("/test.txt")?.content).toBe("hello world");
    });

    it("should suggest similar files on failure", async () => {
      const result = await tools.read_file.execute({ path: "/test2.txt" });
      expect(result.error).toBeDefined();
      expect(result.suggestions).toContain("/test.txt");
    });
  });

  describe("write_file", () => {
    it("should write a file and update fileState", async () => {
      await tools.write_file.execute({ path: "/new.txt", content: "new content" });
      const content = await bash.fs.readFile("/new.txt");
      expect(content).toBe("new content");
      expect(bash.fileState.get("/new.txt")?.content).toBe("new content");
    });
  });

  describe("list_files", () => {
    it("should list files in a directory", async () => {
      const result = await tools.list_files.execute({ path: "/" });
      expect(result.files).toContain("test.txt");
    });

    it("should list files recursively via bash exec", async () => {
      await bash.fs.mkdir("/subdir");
      await bash.fs.writeFile("/subdir/subfile.txt", "sub");
      const result = await tools.list_files.execute({ path: "/", recursive: true });
      // console.log("List recursive output:", result.output);
      expect(result.output).toBeDefined();
      expect(result.output).toContain("subdir");
      expect(result.output).toContain("subfile.txt");
    });
  });

  describe("edit_file", () => {
    it("should apply multiple patches to a file", async () => {
      const path = "/edit.txt";
      await bash.fs.writeFile(path, "line1\nline2\nline3");
      const tools = createAgenticTools(bash);

      const result = await tools.edit_file.execute({
        path,
        patches: [
          { oldText: "line1", newText: "FIRST" },
          { oldText: "line3", newText: "LAST" },
        ],
      });

      expect(result.success).toBe(true);
      const content = await bash.fs.readFile(path);
      expect(content).toBe("FIRST\nline2\nLAST");
      expect(bash.fileState.get(path)?.content).toBe("FIRST\nline2\nLAST");
    });

    it("should return error if patch cannot be found", async () => {
      const path = "/missing.txt";
      await bash.fs.writeFile(path, "hello world");
      const tools = createAgenticTools(bash);

      const result = await tools.edit_file.execute({
        path,
        patches: [{ oldText: "missing", newText: "oops" }],
      });

      expect(result.error).toBeDefined();
      expect(result.failedPatch).toBe("missing");
    });
  });

  describe("analyze_code", () => {
    it("should analyze a bash script and return symbols", async () => {
      const path = "/script.sh";
      const script = "FOO=bar\nfunction myfn() {\n  echo $FOO\n}\n";
      await bash.fs.writeFile(path, script);
      const tools = createAgenticTools(bash);

      const result = await tools.analyze_code.execute({ path });

      expect(result.type).toBe("shell");
      expect(result.symbols).toBeDefined();
      const fnSymbol = result.symbols.find((s: any) => s.name === "myfn");
      expect(fnSymbol).toBeDefined();
      expect(fnSymbol.type).toBe("Function");
      
      const varSymbol = result.symbols.find((s: any) => s.name === "FOO");
      expect(varSymbol).toBeDefined();
      expect(varSymbol.type).toBe("Variable");
    });

    it("should return basic stats for non-shell files", async () => {
      const path = "/data.txt";
      await bash.fs.writeFile(path, "line1\nline2");
      const tools = createAgenticTools(bash);

      const result = await tools.analyze_code.execute({ path });

      expect(result.type).toBe("generic");
      expect(result.lineCount).toBe(2);
    });
  });

  describe("run_command", () => {
    it("should execute a command and return results", async () => {
      const tools = createAgenticTools(bash);
      const result = await tools.run_command.execute({ command: "echo 'hello'" });

      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
