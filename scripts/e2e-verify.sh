#!/bin/bash
set -e

# PATHS
BASH_EXE="node packages/bash/dist/bin/ag-bash.js"
MCP_EXE="node packages/mcp-server/dist/bundle.js"

echo "------------------------------------------------"
echo "🔍 E2E VERIFICATION: Ag-Bash Monorepo"
echo "------------------------------------------------"

# 1. Ag-Bash Core Verification
echo "📁 [1/2] Verifying Core Engine..."

# Test: Interpreter & Pipeline
$BASH_EXE -c "echo 'AG_BASH_E2E_CONFIRM' | sed 's/CONFIRM/MATCHED/'" > /tmp/ag_bash_verify.log 2>&1
if grep -q "AG_BASH_E2E_MATCHED" /tmp/ag_bash_verify.log; then
    echo "  ✅ Interpreter Pipe & Sed: PASS"
else
    echo "  ❌ Interpreter Pipe & Sed: FAIL"
    cat /tmp/ag_bash_verify.log
    exit 1
fi

# Test: Pipeline & JQ
$BASH_EXE -c "echo '{\"status\":\"active\"}' | jq -r .status" > /tmp/ag_bash_verify.log 2>&1
if grep -q "active" /tmp/ag_bash_verify.log; then
    echo "  ✅ Pipeline & JQ: PASS"
else
    echo "  ❌ Pipeline & JQ: FAIL"
    cat /tmp/ag_bash_verify.log
    exit 1
fi

# 2. MCP Server Verification
echo "🤖 [2/2] Verifying Standalone MCP Server..."

# Helpers for JSON-RPC
JSON_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e-tester","version":"1.0.0"}}}'
JSON_LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
JSON_CALL='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_bash","arguments":{"script":"export E2E_VAR=ag-sync-1 && echo \"VAR_SET:$E2E_VAR\""}}}'
JSON_PERSIST='{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"run_bash","arguments":{"script":"echo \"VAR_CHECK:$E2E_VAR\""}}}'

# Run sequence
echo "  🚀 Starting MCP Handshake..."
(
  echo "$JSON_INIT"
  sleep 1
  echo "$JSON_LIST"
  sleep 1
  echo "$JSON_CALL"
  sleep 1
  echo "$JSON_PERSIST"
  sleep 1
) | $MCP_EXE > /tmp/mcp_verify.log 2>&1 || true

# Check Handshake
if grep -q "capabilities" /tmp/mcp_verify.log; then
    echo "  ✅ Protocol Initialize: PASS"
else
    echo "  ❌ Protocol Initialize: FAIL"
    cat /tmp/mcp_verify.log
    exit 1
fi

# Check Persistence
if grep -q "VAR_CHECK:ag-sync-1" /tmp/mcp_verify.log; then
    echo "  ✅ Session Persistence: PASS"
else
    echo "  ❌ Session Persistence: FAIL"
    cat /tmp/mcp_verify.log
    exit 1
fi

echo "------------------------------------------------"
echo "🎊 ALL E2E CHECKS PASSED!"
echo "------------------------------------------------"

# Cleanup
rm -f /tmp/ag_bash_verify.log /tmp/mcp_verify.log
