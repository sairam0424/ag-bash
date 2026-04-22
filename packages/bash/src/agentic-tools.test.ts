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

    it("should apply fuzzy matching for whitespace and line endings", async () => {
      const path = "/fuzzy.txt";
      await bash.fs.writeFile(path, "  line1  \n  line2  ");
      const tools = createAgenticTools(bash);

      const result = await tools.edit_file.execute({
        path,
        patches: [{ oldText: "line1\nline2", newText: "NEW_CONTENT" }],
      });

      expect(result.success).toBe(true);
      const content = await bash.fs.readFile(path);
      expect(content).toContain("NEW_CONTENT");
    });
  });

  describe("analyze_code", () => {
    it("should analyze a bash script and return symbols and summary", async () => {
      const path = "/script.sh";
      const script = "FOO=bar\nfunction myfn() {\n  echo $FOO\n}\n";
      await bash.fs.writeFile(path, script);
      const tools = createAgenticTools(bash);

      const result = await tools.analyze_code.execute({ path });

      expect(result.type).toBe("shell");
      expect(result.summary).toContain("FOO=bar");
      const fnSymbol = result.symbols.find((s: any) => s.name === "myfn");
      expect(fnSymbol).toBeDefined();
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

  describe("find_symbols", () => {
    it("should find symbols across multiple shell scripts", async () => {
      await bash.fs.mkdir("/src");
      await bash.fs.writeFile("/src/a.sh", "funcA() { :; }");
      await bash.fs.writeFile("/src/b.sh", "funcB() { :; }");
      const tools = createAgenticTools(bash);

      const result = await tools.find_symbols.execute({ path: "/src" });

      expect(result.results.length).toBe(2);
      expect(result.results.some((s: any) => s.name === "funcA")).toBe(true);
      expect(result.results.some((s: any) => s.name === "funcB")).toBe(true);
    });

    it("should filter results by query", async () => {
      await bash.fs.mkdir("/query");
      await bash.fs.writeFile("/query/test.sh", "targetFunc() { :; }\notherFunc() { :; }");
      const tools = createAgenticTools(bash);

      const result = await tools.find_symbols.execute({ path: "/query", query: "target" });

      expect(result.results.length).toBe(1);
      expect(result.results[0].name).toBe("targetFunc");
    });
  });

  describe("explain_command", () => {
    it("should explain a simple command", async () => {
      const tools = createAgenticTools(bash);
      const result = await tools.explain_command.execute({ command: "ls -la" });

      expect(result.explanation).toContain("Executes 'ls'");
      expect(result.explanation).toContain("-la");
    });

    it("should explain a pipeline", async () => {
      const tools = createAgenticTools(bash);
      const result = await tools.explain_command.execute({ command: "ls | grep test" });

      expect(result.explanation).toContain("A pipeline");
      expect(result.explanation).toContain("Executes 'ls'");
      expect(result.explanation).toContain("Executes 'grep'");
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

  describe("find_files", () => {
    it("should find files by glob pattern", async () => {
      await bash.fs.mkdir("/search");
      await bash.fs.writeFile("/search/test1.ts", "content");
      await bash.fs.writeFile("/search/test2.js", "content");
      await bash.fs.writeFile("/search/other.ts", "content");
      
      const result = await tools.find_files.execute({ path: "/search", pattern: "*.ts" });
      
      expect(result.results.length).toBe(2);
      expect(result.results).toContain("/search/test1.ts");
      expect(result.results).toContain("/search/other.ts");
    });
  });

  describe("grep_search", () => {
    it("should search text across files", async () => {
      await bash.fs.mkdir("/grep");
      await bash.fs.writeFile("/grep/a.txt", "found target here");
      await bash.fs.writeFile("/grep/b.txt", "nothing here");
      await bash.fs.writeFile("/grep/c.txt", "another target");
      
      const result = await tools.grep_search.execute({ path: "/grep", query: "target" });
      
      expect(result.results.length).toBe(2);
      expect(result.results[0].path).toBe("/grep/a.txt");
      expect(result.results[1].path).toBe("/grep/c.txt");
      expect(result.results[0].content).toContain("found target");
    });
  });

  describe("check_environment", () => {
    it("should return environment state and limits", async () => {
      const result = await tools.check_environment.execute({});
      
      expect(result.cwd).toBeDefined();
      expect(result.limits).toBeDefined();
      expect(result.usage.commandCount).toBeGreaterThanOrEqual(0);
      expect(result.capabilities).toContain("Granular Tools");
    });
  });
});
