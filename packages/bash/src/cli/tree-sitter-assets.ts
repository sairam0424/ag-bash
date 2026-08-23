/**
 * Vendored Tree-sitter WASM asset locator for the CLI entry points.
 *
 * WHY THIS IS PATHS AND NOT BYTES
 * -------------------------------
 * `Bash`'s default parser engine is "legacy" (`options.parser?.engine ??
 * "legacy"` in Bash.ts), and ParseStage reads `treeSitterConfig` only when the
 * engine is "tree-sitter". Both CLIs pass a `treeSitterConfig` unconditionally
 * — ag-bash has no flag to select the tree-sitter engine at all — so any bytes
 * read while building that config are, for every ordinary `ag-bash -c '...'`
 * invocation, read and retained for nothing (1.55 MB across
 * web-tree-sitter.wasm + tree-sitter-bash.wasm).
 *
 * `BashOptions.parser.treeSitterConfig` accepts `string | Uint8Array` for both
 * assets, and `TreeSitterParser.init()` resolves a string as a filesystem path
 * (via emscripten's `locateFile` for the runtime, and `Language.load(path)` for
 * the grammar). Handing it paths therefore defers the read to the one place
 * that actually needs the bytes, without making the deferral conditional on how
 * the engine was selected: flag, programmatic config or env all keep working,
 * because the config itself is always present and always resolvable.
 *
 * Returning paths also means a missing/oddly-laid-out vendor directory can no
 * longer break the default engine, which never touches these files.
 */

import { join } from "node:path";

/** Emscripten runtime for web-tree-sitter (~197 KB). */
const WEB_TREE_SITTER_WASM = "web-tree-sitter.wasm";
/** Compiled tree-sitter bash grammar (~1.36 MB). */
const BASH_GRAMMAR_WASM = "tree-sitter-bash.wasm";

/**
 * Absolute paths to the vendored Tree-sitter assets. Structurally assignable to
 * `BashOptions["parser"]["treeSitterConfig"]`.
 */
export interface TreeSitterWasmConfig {
  webTreeSitterWasm: string;
  bashGrammarWasm: string;
}

/**
 * Build the Tree-sitter config for a `parser/vendor` directory.
 *
 * Pure path math: performs NO filesystem access, so it costs nothing on the
 * default (legacy) parser path and cannot fail when the assets are absent.
 */
export function createTreeSitterConfig(
  vendorDir: string,
): TreeSitterWasmConfig {
  return {
    webTreeSitterWasm: join(vendorDir, WEB_TREE_SITTER_WASM),
    bashGrammarWasm: join(vendorDir, BASH_GRAMMAR_WASM),
  };
}
