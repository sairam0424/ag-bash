import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import { TreeSitterParser } from "../../parser/tree-sitter-parser.js";
import { agAnalyzeCommand } from "./ag-analyze.js";

vi.mock("../../parser/tree-sitter-parser.js", () => ({
  TreeSitterParser: {
    parse: vi.fn(),
  },
}));

vi.mock("../../parser/tree-sitter-to-ast.js", () => {
  return {
    TreeSitterToAst: vi.fn().mockImplementation(() => ({
      convert: () => ({
        type: "Script",
        statements: [
          {
            type: "FunctionDef",
            name: "hello",
            line: 1,
            body: { type: "Script", statements: [] },
          },
        ],
      }),
    })),
  };
});

describe("ag-analyze", () => {
  let fs: InMemoryFs;
  let ctx: any;

  beforeEach(() => {
    fs = new InMemoryFs({
      "script.sh": "hello() { echo world; }",
      "text.txt": "just text",
    });
    ctx = {
      fs,
      cwd: "/",
      stdin: "",
    };
  });

  it("should show basic file info for non-bash files", async () => {
    const result = await agAnalyzeCommand.execute(["text.txt"], ctx);
    expect(result.stdout).toContain("File: text.txt");
    expect(result.stdout).toContain(
      "Deep semantic analysis currently only supported for Bash scripts",
    );
  });

  it("should analyze bash functions using SemanticEngine", async () => {
    const result = await agAnalyzeCommand.execute(["script.sh"], ctx);
    if (result.exitCode !== 0) console.error("DEBUG ERR:", result.stderr);
    expect(result.stdout).toContain("Functions (1):");
    expect(result.stdout).toContain("- hello (line 1)");
  });

  it("should output JSON symbols with --symbols", async () => {
    const result = await agAnalyzeCommand.execute(
      ["script.sh", "--symbols"],
      ctx,
    );
    try {
      const symbols = JSON.parse(result.stdout);
      expect(Array.isArray(symbols)).toBe(true);
      expect(symbols[0].name).toBe("hello");
      expect(symbols[0].type).toBe("Function");
    } catch (e) {
      throw new Error(
        `JSON parse failed! stdout: ${result.stdout} stderr: ${result.stderr} err: ${e}`,
      );
    }
  });
});
