---
"@ag-bash/bash": patch
"@ag-bash/mcp-server": patch
"@ag-bash/agent-bridge": patch
---

Upgrade `vitest`/`@vitest/coverage-v8` from 4.x to 5.0.2 (internal tooling only, no public API change). Does not adopt TypeScript 7.0 — a confirmed live bug (microsoft/TypeScript#63705) hits this repo's exact build shape (pnpm symlinked `node_modules` + `isolatedDeclarations`); staying on TypeScript 5.9.3 until that's resolved.
