---
"@ag-bash/mcp-server": patch
---

Fix the `serverInfo.version` reported in MCP `initialize` responses — it was hardcoded to a stale `"6.0.2"` while the actual published package had moved on to `6.0.5`. Found while verifying the Docker image; this literal is deliberately not read from `package.json` at runtime (see the comment above `SERVER_VERSION`), so it needs manual bumping and isn't caught by the existing `check:version-sync` guard (which only compares the three packages' `package.json` versions to each other, not this embedded string).
