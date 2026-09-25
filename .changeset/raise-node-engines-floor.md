---
"@ag-bash/bash": minor
"@ag-bash/mcp-server": minor
"@ag-bash/agent-bridge": minor
---

Raise the minimum supported Node.js version from `>=20.6.0` to `>=22.12.0`. Node 20 reached end-of-life; Node 22 is the oldest currently-maintained line and already covered by this repo's own CI matrix. The `unit` CI job's ubuntu matrix drops Node 20 accordingly (now `[22, 24]`).
