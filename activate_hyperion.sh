#!/bin/bash
# Hyperion Superpower Activation Script

echo "🚀 Activating Hyperion Superpower..."

# 1. Build the project to register the new command
echo "Step 1: Building ag-bash..."
pnpm build --filter @ag-bash/bash

# 2. Run the setup
echo "Step 2: Installing Python dependencies (Docling + MarkItDown)..."
node ./packages/bash/dist/bin/ag-bash.js ag-convert --setup

echo "✅ Hyperion is now ACTIVE!"
echo "Usage: ag-bash ag-convert <file>"
