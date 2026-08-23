/**
 * Lazy Tree-sitter WASM loading for the CLI entry points.
 *
 * The CLIs hand a `parser.treeSitterConfig` to `Bash`, but the DEFAULT parser
 * engine is "legacy" (Bash.ts: `options.parser?.engine ?? "legacy"`), and
 * ParseStage only touches the config when the engine is "tree-sitter". So for
 * the common `ag-bash -c '...'` invocation the vendored grammar must never be
 * read at all.
 *
 * These tests pin that as a behavioural contract rather than a filesystem
 * snapshot:
 *   - the config is pure path math, so it works even for a vendor directory
 *     that does not exist (an eager `readFileSync` would throw ENOENT);
 *   - the loader (`TreeSitterParser.init`) is NEVER invoked for the default
 *     engine, and IS invoked — with the vendored paths — when the tree-sitter
 *     engine is selected, whether that selection comes from a flag or from
 *     programmatic config.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bash } from "../Bash.js";
import { TreeSitterParser } from "../parser/tree-sitter-parser.js";
import { createTreeSitterConfig } from "./tree-sitter-assets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Pinned independently of the implementation on purpose: these two names are
 * what scripts/check-pack-contents.js asserts ship in the tarball
 * (dist/parser/vendor/*), so the test must fail if the config ever points
 * somewhere else.
 */
const WEB_TREE_SITTER_WASM = "web-tree-sitter.wasm";
const BASH_GRAMMAR_WASM = "tree-sitter-bash.wasm";

/** The layout every CLI entry point resolves to (src/cli -> src/parser/vendor). */
const realVendorDir = join(__dirname, "..", "parser", "vendor");

/**
 * A directory that provably does not exist. Building a config against it is the
 * cheapest possible proof that no bytes were read: an eager loader throws
 * ENOENT here, a lazy one just returns two strings.
 */
const missingVendorDir = join(
  __dirname,
  "..",
  "parser",
  "vendor-intentionally-absent",
);

describe("createTreeSitterConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is pure path math — no filesystem access, even for a missing dir", () => {
    expect(existsSync(missingVendorDir)).toBe(false);

    const config = createTreeSitterConfig(missingVendorDir);

    expect(config.webTreeSitterWasm).toBe(
      join(missingVendorDir, WEB_TREE_SITTER_WASM),
    );
    expect(config.bashGrammarWasm).toBe(
      join(missingVendorDir, BASH_GRAMMAR_WASM),
    );
  });

  it("hands Bash paths, not eagerly-read bytes", () => {
    const config = createTreeSitterConfig(realVendorDir);

    expect(typeof config.webTreeSitterWasm).toBe("string");
    expect(typeof config.bashGrammarWasm).toBe("string");
    expect(config.webTreeSitterWasm).not.toBeInstanceOf(Uint8Array);
    expect(config.bashGrammarWasm).not.toBeInstanceOf(Uint8Array);
  });

  it("resolves the real vendored assets", () => {
    const config = createTreeSitterConfig(realVendorDir);

    expect(existsSync(config.webTreeSitterWasm)).toBe(true);
    expect(existsSync(config.bashGrammarWasm)).toBe(true);
  });
});

describe("tree-sitter loader invocation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is NEVER invoked for the default parser engine", async () => {
    const initSpy = vi.spyOn(TreeSitterParser, "init");

    // Deliberately point at the absent vendor dir: if anything on the default
    // path loaded the grammar, this exec could not succeed.
    await using bash = new Bash({
      parser: { treeSitterConfig: createTreeSitterConfig(missingVendorDir) },
    });
    const result = await bash.exec("echo hello");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(initSpy).not.toHaveBeenCalled();
  });

  it("is invoked with the vendored paths when the tree-sitter engine is selected", async () => {
    const initSpy = vi.spyOn(TreeSitterParser, "init");
    const config = createTreeSitterConfig(realVendorDir);

    await using bash = new Bash({
      parser: { engine: "tree-sitter", treeSitterConfig: config },
    });
    // A compound statement, not just `echo`: this only produces the right AST
    // if the bash grammar WASM really was loaded from the path we handed over.
    const result = await bash.exec(
      'V=1; if [ "$V" -eq 1 ]; then echo grammar-loaded; fi',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("grammar-loaded\n");
    expect(initSpy).toHaveBeenCalledTimes(1);

    const initArg = initSpy.mock.calls[0][0];
    expect(initArg.webTreeSitterWasm).toBe(config.webTreeSitterWasm);
    expect(initArg.grammars?.bash).toBe(config.bashGrammarWasm);
  });
});

describe("CLI wiring", () => {
  // The defect was `readFileSync(join(vendorDir, "…wasm"))` in ag-bash.ts's
  // main(). Both entry points must route through the lazy locator instead.
  it.each([
    "ag-bash.ts",
    "shell.ts",
  ])("cli/%s does not read the vendored WASM at startup", (file) => {
    const source = readFileSync(join(__dirname, file), "utf-8");

    expect(source).not.toMatch(/readFileSync\([^)]*wasm/);
    expect(source).toContain("createTreeSitterConfig");
  });
});
