#!/bin/bash
set -e

# Setup paths
export PATH="./node_modules/.bin:/opt/homebrew/bin:$PATH"

echo "Step 1: Cleaning dist..."
rm -rf dist

echo "Step 2: Compiling TypeScript..."
tsc

echo "Step 3: Building workers..."
esbuild src/commands/python3/worker.ts --bundle --platform=node --format=esm --outfile=src/commands/python3/worker.js --external:../../../vendor/cpython-emscripten/*
esbuild src/commands/js-exec/worker.ts --bundle --platform=node --format=esm --outfile=src/commands/js-exec/worker.js --external:quickjs-emscripten

echo "Step 4: Copying workers to dist..."
mkdir -p dist/bin/chunks/cpython-emscripten
cp src/commands/python3/worker.js dist/bin/chunks/worker.js
cp -r vendor/cpython-emscripten/* dist/bin/chunks/cpython-emscripten/

mkdir -p dist/bin/shell/chunks/cpython-emscripten
cp src/commands/python3/worker.js dist/bin/shell/chunks/worker.js
cp -r vendor/cpython-emscripten/* dist/bin/shell/chunks/cpython-emscripten/

mkdir -p dist/bundle/chunks/cpython-emscripten
cp src/commands/python3/worker.js dist/bundle/chunks/worker.js
cp -r vendor/cpython-emscripten/* dist/bundle/chunks/cpython-emscripten/

mkdir -p dist/commands/js-exec
cp src/commands/js-exec/worker.js dist/commands/js-exec/worker.js
cp src/commands/js-exec/worker.js dist/bin/chunks/js-exec-worker.js
cp src/commands/js-exec/worker.js dist/bin/shell/chunks/js-exec-worker.js
cp src/commands/js-exec/worker.js dist/bundle/chunks/js-exec-worker.js



echo "Step 5: Building Lib (ESM)..."
esbuild dist/index.js --bundle --splitting --platform=node --format=esm --minify --outdir=dist/bundle --chunk-names=chunks/[name]-[hash] --external:diff --external:minimatch --external:sprintf-js --external:turndown --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip

echo "Step 6: Building Lib (CJS)..."
esbuild dist/index.js --bundle --platform=node --format=cjs --minify --outfile=dist/bundle/index.cjs --external:diff --external:minimatch --external:sprintf-js --external:turndown --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip

echo "Step 7: Building Browser..."
esbuild dist/browser.js --bundle --platform=browser --format=esm --minify --outfile=dist/bundle/browser.js --external:diff --external:minimatch --external:sprintf-js --external:turndown --external:node:zlib --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip --define:__BROWSER__=true --alias:node:dns=./src/shims/browser-unsupported.js

echo "Step 8: Building CLI..."
esbuild dist/cli/ag-bash.js --bundle --splitting --platform=node --format=esm --minify --outdir=dist/bin --entry-names=[name] --chunk-names=chunks/[name]-[hash] --banner:js='#!/usr/bin/env node' --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip

echo "Step 9: Building Shell..."
esbuild dist/cli/shell.js --bundle --splitting --platform=node --format=esm --minify --outdir=dist/bin/shell --entry-names=[name] --chunk-names=chunks/[name]-[hash] --banner:js='#!/usr/bin/env node' --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip

echo "Step 10: Cleaning dist tests..."
find dist -name '*.test.js' -delete
find dist -name '*.test.d.ts' -delete

echo "Step 11: Final touches..."
cp dist/index.d.ts dist/index.d.cts
sed '1,/^-->/d' AGENTS.npm.md > dist/AGENTS.md
chmod +x dist/bin/ag-bash.js dist/bin/shell/shell.js

echo "Build complete!"
