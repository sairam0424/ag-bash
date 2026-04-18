#!/bin/bash
set -e

ROOT=$(pwd)

echo "🚀 Starting Ag-Bash Monorepo Force Build..."

# --- 1. Build @ag-bash/bash ---
echo "📦 Building @ag-bash/bash..."
cd "$ROOT/packages/bash"

# Cleanup
rm -rf dist

# Compile TS
npx tsc

# Build Workers
echo "⚙️ Building Workers..."
npx esbuild src/commands/python3/worker.ts --bundle --platform=node --format=esm --outfile=src/commands/python3/worker.js --external:../../../vendor/cpython-emscripten/*
npx esbuild src/commands/js-exec/worker.ts --bundle --platform=node --format=esm --outfile=src/commands/js-exec/worker.js --external:quickjs-emscripten

# Copy Workers to dist
mkdir -p dist/commands/python3 dist/commands/js-exec
cp src/commands/python3/worker.js dist/commands/python3/worker.js
cp src/commands/js-exec/worker.js dist/commands/js-exec/worker.js

# Build Libraries
echo "🏗️ Building Libraries (ESM/CJS/Browser)..."
npx esbuild dist/index.js --bundle --splitting --platform=node --format=esm --minify --outdir=dist/bundle --chunk-names=chunks/[name]-[hash] --external:diff --external:minimatch --external:sprintf-js --external:turndown --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip
npx esbuild dist/index.js --bundle --platform=node --format=cjs --minify --outfile=dist/bundle/index.cjs --define:import.meta.url='""' --external:diff --external:minimatch --external:sprintf-js --external:turndown --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip
npx esbuild dist/browser.js --bundle --platform=browser --format=esm --minify --outfile=dist/bundle/browser.js --external:diff --external:minimatch --external:sprintf-js --external:turndown --external:node:zlib --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip --define:__BROWSER__=true --alias:node:dns=./src/shims/browser-dns.ts

# Build CLI & Shell
echo "💻 Building CLI & Shell..."
npx esbuild dist/cli/ag-bash.js --bundle --splitting --platform=node --format=esm --minify --outdir=dist/bin --entry-names=[name] --chunk-names=chunks/[name]-[hash] --banner:js='#!/usr/bin/env node' --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip
npx esbuild dist/cli/shell.js --bundle --splitting --platform=node --format=esm --minify --outdir=dist/bin/shell --entry-names=[name] --chunk-names=chunks/[name]-[hash] --banner:js='#!/usr/bin/env node' --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip

chmod +x dist/bin/ag-bash.js dist/bin/shell/shell.js

# --- 2. Build @ag-bash/mcp-server ---
echo "🤖 Building @ag-bash/mcp-server..."
cd "$ROOT/packages/mcp-server"

# Cleanup
rm -rf dist

# Compile TS (Note: we use -p to point to local config)
npx tsc

# Bundle MCP Server with mirrored path from tsc
echo "🏗️ Bundling Standalone MCP Server..."
npx esbuild dist/mcp-server/src/index.js --bundle --platform=node --format=esm --minify --outfile=dist/index.js --banner:js='#!/usr/bin/env node' --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip

chmod +x dist/index.js

cd "$ROOT"
echo "✅ Monorepo Force Build Complete!"
