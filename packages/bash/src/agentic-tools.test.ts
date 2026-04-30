import { beforeEach, describe, expect, it, vi } from "vitest";
import { BashToolbox } from "./agentic/BashToolbox.js";
import { Bash } from "./Bash.js";
import { InMemoryFs } from "./fs/in-memory-fs/index.js";
import { SymbolType } from "./lsp/semantic-engine.js";
import { hashString } from "./utils/crypto.js";

describe("Agentic Tools (BashToolbox)", () => {
  let bash: Bash;
  let tools: any;

  beforeEach(() => {
    bash = new Bash({
      parser: { engine: "legacy" },
      runtimes: { python: true, javascript: true },
      fs: new InMemoryFs({
        "/test.txt": "hello world",
      }),
    });
    const toolbox = new BashToolbox();
    tools = toolbox.getAgenticTools(bash);
  });

  describe("read_file", () => {
    it("should read a file", async () => {
      const result = await tools.read_file.execute({ path: "/test.txt" });
      expect(result).toBe("hello world");
    });
  });

  describe("write_file", () => {
    it("should write a file", async () => {
      const result = await tools.write_file.execute({
        path: "/new.txt",
        content: "new content",
      });
      expect(result).toContain("Successfully wrote");
      const content = await bash.readFileDirect("/new.txt");
      expect(content).toBe("new content");
    });
  });

  describe("list_dir", () => {
    it("should list files in a directory", async () => {
      const result = await tools.list_dir.execute({ path: "/" });
      expect(result).toContain("test.txt");
    });
  });

  describe("edit_file", () => {
    it("should apply patches to a file", async () => {
      const path = "/edit.txt";
      await bash.writeFileDirect(path, "line1\nline2\nline3");

      const result = await tools.edit_file.execute({
        path,
        target: "line2",
        replacement: "MIDDLE",
      });

      expect(result).toContain("Successfully edited");
      const content = await bash.readFileDirect(path);
      expect(content).toBe("line1\nMIDDLE\nline3");
    });
  });

  describe("ag_edit", () => {
    it("should apply multiple edits in order", async () => {
      const path = "/edit_multi.txt";
      await bash.writeFileDirect(path, "A\nB\nC");

      const result = await tools.ag_edit.execute({
        filePath: path,
        edits: [
          { action: "replace", line: 2, text: "B2" },
          { action: "append", text: "D" },
        ],
      });

      expect(result).toContain("Successfully updated");
      const content = await bash.readFileDirect(path);
      expect(content).toBe("A\nB2\nC\nD");
    });

    it("should fail if the hash does not match", async () => {
      const path = "/stale.txt";
      await bash.writeFileDirect(path, "v1");

      const wrongHash =
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      const result = await tools.ag_edit.execute({
        filePath: path,
        edits: [{ action: "replace", line: 1, text: "v2" }],
        expectedHash: wrongHash,
      });

      expect(result).toContain("Stale Edit Error");
      const content = await bash.readFileDirect(path);
      expect(content).toBe("v1");
    });

    it("should succeed if the hash matches", async () => {
      const path = "/fresh.txt";
      const initialContent = "v1";
      await bash.writeFileDirect(path, initialContent);
      const currentHash = hashString(initialContent);

      const result = await tools.ag_edit.execute({
        filePath: path,
        edits: [{ action: "replace", line: 1, text: "v2" }],
        expectedHash: currentHash,
      });

      expect(result).not.toContain("Stale Edit Error");
      const content = await bash.readFileDirect(path);
      expect(content).toBe("v2");
    });
  });

  describe("analyze_code", () => {
    it("should analyze a bash script", async () => {
      const path = "/script.sh";
      const script = "FOO=bar\nfunction myfn() {\n  echo $FOO\n}\n";
      await bash.writeFileDirect(path, script);

      const result = await tools.analyze_code.execute({ path });

      expect(result.type).toBe("shell");
      const fnSymbol = result.symbols.find((s: any) => s.name === "myfn");
      expect(fnSymbol).toBeDefined();
    });
  });

  describe("find_symbols", () => {
    it("should find symbols via fuzzy search", async () => {
      vi.spyOn(bash.semanticEngine, "fuzzySearchSymbols").mockReturnValue([
        {
          name: "myFunc",
          type: SymbolType.Function,
          line: 1,
          column: 0,
          scope: "global",
          path: "/a.sh",
        },
      ]);

      const result = await tools.find_symbols.execute({ query: "my" });

      expect(result.length).toBe(1);
      expect(result[0].name).toBe("myFunc");
    });
  });

  describe("run_command", () => {
    it("should execute a command", async () => {
      const result = await tools.run_command.execute({
        command: "echo 'hello'",
      });
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("check_environment", () => {
    it("should return diagnostics", async () => {
      const result = await tools.check_environment.execute({});
      expect(result.cwd).toBeDefined();
      expect(result.version).toBe("Ag-Bash vNext");
    });
  });
});
