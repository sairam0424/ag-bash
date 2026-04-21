import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(__dirname, '..');

const SRC_VENDOR = path.join(pkgRoot, 'src', 'parser', 'vendor');
const ROOT_VENDOR = path.join(pkgRoot, 'vendor');

const NODE_MODULES = [
  path.join(pkgRoot, 'node_modules'),
  path.join(pkgRoot, '..', '..', 'node_modules'), // Monorepo fallback
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
  console.log(`[setup-vendor] Copied: ${path.basename(src)} -> ${dest.replace(pkgRoot, '')}`);
}

console.log("[setup-vendor] Initializing Tree-sitter binary setup...");

// 1. web-tree-sitter (JS + WASM)
const wtJs = findModuleFile('web-tree-sitter', 'web-tree-sitter.js');
const wtWasm = findModuleFile('web-tree-sitter', 'web-tree-sitter.wasm');

copyFile(wtJs, path.join(SRC_VENDOR, 'web-tree-sitter.js'));
copyFile(wtWasm, path.join(SRC_VENDOR, 'web-tree-sitter.wasm'));
copyFile(wtWasm, path.join(ROOT_VENDOR, 'web-tree-sitter.wasm')); // Also used in tests from root/vendor

// 2. tree-sitter-bash (Grammar WASM)
const bashGrammar = findModuleFile('tree-sitter-bash', 'tree-sitter-bash.wasm');
copyFile(bashGrammar, path.join(ROOT_VENDOR, 'tree-sitter-bash.wasm'));

console.log("[setup-vendor] Binary synchronization COMPLETE.");
