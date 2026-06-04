import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(__dirname, "..");

const SRC_VENDOR = path.join(pkgRoot, "src", "parser", "vendor");
const ROOT_VENDOR = path.join(pkgRoot, "vendor");

const NODE_MODULES = [
  path.join(pkgRoot, "node_modules"),
  path.join(pkgRoot, "..", "..", "node_modules"), // Monorepo fallback
];

function findModuleFile(moduleName, filePath) {
  for (const root of NODE_MODULES) {
    const fullPath = path.join(root, moduleName, filePath);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

function copyFile(src, dest) {
  if (!src) {
    console.error(`[setup-vendor] Source file NOT found for target: ${dest}`);
    return;
  }

  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  fs.copyFileSync(src, dest);
  console.log(
    `[setup-vendor] Copied: ${path.basename(src)} -> ${dest.replace(pkgRoot, "")}`,
  );
}

console.log("[setup-vendor] Initializing Tree-sitter binary setup...");

// 1. web-tree-sitter (JS + WASM + sourcemap)
const wtJs = findModuleFile("web-tree-sitter", "web-tree-sitter.js");
const wtWasm = findModuleFile("web-tree-sitter", "web-tree-sitter.wasm");
// The published web-tree-sitter.js ends with
//   //# sourceMappingURL=web-tree-sitter.js.map
// so any source-map-aware loader (vite/vitest, node --enable-source-maps)
// reads the adjacent .map when the module is imported. If we copy only the
// .js without its .map, that read fails with ENOENT and pollutes the bench
// run output (and trips strict "no stderr" gates). Vendor the .map alongside
// the .js so the sourceMappingURL resolves. `findModuleFile` returns null if
// a future version drops the map; copyFile then no-ops (with a notice) rather
// than failing the run.
const wtJsMap = findModuleFile("web-tree-sitter", "web-tree-sitter.js.map");

copyFile(wtJs, path.join(SRC_VENDOR, "web-tree-sitter.js"));
copyFile(wtWasm, path.join(SRC_VENDOR, "web-tree-sitter.wasm"));
copyFile(wtWasm, path.join(ROOT_VENDOR, "web-tree-sitter.wasm")); // Also used in tests from root/vendor
if (wtJsMap) {
  copyFile(wtJsMap, path.join(SRC_VENDOR, "web-tree-sitter.js.map"));
} else {
  console.log(
    "[setup-vendor] Notice: web-tree-sitter.js.map not present in node_modules; " +
      "skipping (sourceMappingURL may 404 in source-map-aware loaders).",
  );
}

// 2. tree-sitter-bash (Grammar WASM)
const bashGrammar = findModuleFile("tree-sitter-bash", "tree-sitter-bash.wasm");
copyFile(bashGrammar, path.join(ROOT_VENDOR, "tree-sitter-bash.wasm"));
// Also place into src/parser/vendor so the build's `cp src/parser/vendor/*`
// carries it into dist/parser/vendor — the dir the bundled bin reads at runtime
// (mirrors how web-tree-sitter.wasm is provisioned to both vendor dirs above).
copyFile(bashGrammar, path.join(SRC_VENDOR, "tree-sitter-bash.wasm"));

console.log("[setup-vendor] Binary synchronization COMPLETE.");
