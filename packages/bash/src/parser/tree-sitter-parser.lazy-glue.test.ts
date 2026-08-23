/**
 * The vendored `web-tree-sitter.js` emscripten glue is 153,666 bytes of source
 * that Node must parse and evaluate. Nothing on the DEFAULT execution path ever
 * needs it: `Bash` defaults `parser.engine` to "legacy" and ParseStage gates
 * both tree-sitter branches on `parserEngine === "tree-sitter"`, while the
 * `ag-bash` CLI exposes no flag or env var that selects tree-sitter at all.
 *
 * A static top-level `import * as TreeSitter from "./vendor/web-tree-sitter.js"`
 * made that evaluation unconditional: every importer of this module (ParseStage,
 * ServiceContainer, WorkspaceIndexer, ag-analyze) dragged the glue into the CLI
 * bundle AND evaluated it at startup.
 *
 * These tests pin the deferral as a behavioural contract rather than a source
 * grep: the mock factory below runs exactly when the vendored module is first
 * imported, so its call count *is* the evaluation count.
 */

import { describe, expect, it, vi } from "vitest";

const glue = vi.hoisted(() => ({ evaluations: 0 }));

vi.mock("./vendor/web-tree-sitter.js", () => {
  glue.evaluations += 1;

  function FakeParser(this: { language: unknown }) {
    this.language = null;
  }
  FakeParser.init = vi.fn(async () => {});
  FakeParser.prototype.setLanguage = function (lang: unknown) {
    this.language = lang;
  };
  FakeParser.prototype.parse = (code: string) => ({ parsed: code });

  return {
    Parser: FakeParser,
    Language: { load: vi.fn(async (src: unknown) => ({ src })) },
  };
});

const MISSING_WASM = "/nonexistent/web-tree-sitter.wasm";

describe("TreeSitterParser vendored-glue deferral", () => {
  it("does not evaluate the vendored glue merely by importing the module", async () => {
    const { TreeSitterParser } = await import("./tree-sitter-parser.js");

    expect(TreeSitterParser).toBeDefined();
    expect(glue.evaluations).toBe(0);
  });

  it("keeps the un-initialised failure mode unchanged", async () => {
    const { TreeSitterParser } = await import("./tree-sitter-parser.js");
    TreeSitterParser.resetForTest();

    expect(() => TreeSitterParser.parse("echo hi")).toThrow(
      "TreeSitterParser not initialized. Call init() first.",
    );
    expect(glue.evaluations).toBe(0);
  });

  it("evaluates the glue exactly once, on the first init()", async () => {
    const { TreeSitterParser } = await import("./tree-sitter-parser.js");
    TreeSitterParser.resetForTest();

    await TreeSitterParser.init({ webTreeSitterWasm: MISSING_WASM });
    expect(glue.evaluations).toBe(1);

    TreeSitterParser.resetForTest();
    await TreeSitterParser.init({ webTreeSitterWasm: MISSING_WASM });
    expect(glue.evaluations).toBe(1);
  });

  it("still resolves the glue for loadLanguage()", async () => {
    const { TreeSitterParser } = await import("./tree-sitter-parser.js");
    TreeSitterParser.resetForTest();

    await TreeSitterParser.loadLanguage("bash", "/nonexistent/bash.wasm");

    expect(TreeSitterParser.getLanguage("bash")).toBeDefined();
    expect(glue.evaluations).toBe(1);
  });
});
