#!/bin/bash
set -e

echo "🚀 Starting Ag-Bash Force Build (Manual)..."

# 1. Cleanup
echo "🧹 Cleaning dist..."
rm -rf dist

# 2. Compile TypeScript
echo "📦 Compiling TypeScript..."
npx tsc

# 3. Build Libraries
echo "🏗️ Building ESM library..."
npx esbuild dist/index.js --bundle --splitting --platform=node --format=esm --minify --outdir=dist/bundle --chunk-names=chunks/[name]-[hash] --external:diff --external:minimatch --external:sprintf-js --external:turndown --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip

echo "🏗️ Building CJS library..."
npx esbuild dist/index.js --bundle --platform=node --format=cjs --minify --outfile=dist/bundle/index.cjs --external:diff --external:minimatch --external:sprintf-js --external:turndown --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip

echo "🌐 Building Browser library..."
npx esbuild dist/browser.js --bundle --platform=browser --format=esm --minify --outfile=dist/bundle/browser.js --external:diff --external:minimatch --external:sprintf-js --external:turndown --external:node:zlib --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip --define:__BROWSER__=true --alias:node:dns=./src/shims/browser-unsupported.js

# 4. Build CLI & Shell
echo "💻 Building CLI..."
npx esbuild dist/cli/ag-bash.js --bundle --splitting --platform=node --format=esm --minify --outdir=dist/bin --entry-names=[name] --chunk-names=chunks/[name]-[hash] --banner:js='#!/usr/bin/env node' --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip

echo "🐚 Building Shell..."
npx esbuild dist/cli/shell.js --bundle --splitting --platform=node --format=esm --minify --outdir=dist/bin/shell --entry-names=[name] --chunk-names=chunks/[name]-[hash] --banner:js='#!/usr/bin/env node' --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip

# 5. Build Workers
echo "⚙️ Building Python Worker..."
npx esbuild src/commands/python3/worker.ts --bundle --platform=node --format=esm --outfile=src/commands/python3/worker.js --external:../../../vendor/cpython-emscripten/*
cp src/commands/python3/worker.js dist/commands/python3/worker.js
mkdir -p dist/bin/chunks
cp src/commands/python3/worker.js dist/bin/chunks/worker.js
mkdir -p dist/bundle/chunks
cp src/commands/python3/worker.js dist/bundle/chunks/worker.js

echo "⚙️ Building JS Worker..."
npx esbuild src/commands/js-exec/worker.ts --bundle --platform=node --format=esm --outfile=src/commands/js-exec/worker.js --external:quickjs-emscripten
cp src/commands/js-exec/worker.js dist/commands/js-exec/worker.js
cp src/commands/js-exec/worker.js dist/bin/chunks/js-exec-worker.js
cp src/commands/js-exec/worker.js dist/bundle/chunks/js-exec-worker.js

# 6. Cleanup Dist
echo "🧹 Cleaning up tests from dist..."
find dist -name '*.test.js' -delete
find dist -name '*.test.d.ts' -delete

# 7. Post-processing
echo "📑 Processing declaration files and metadata..."
cp dist/index.d.ts dist/index.d.cts
sed '1,/^-->/d' AGENTS.npm.md > dist/AGENTS.md
chmod +x dist/bin/ag-bash.js dist/bin/shell/shell.js

echo "✅ Force Build Complete!"
