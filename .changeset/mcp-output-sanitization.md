---
"@ag-bash/mcp-server": patch
---

Scrub terminal-escape sequences, control bytes, and invisible/bidi Unicode (Trojan-Source) from tool output before it reaches the MCP client, defending against output-borne prompt injection. On by default (`AG_BASH_MCP_NO_SANITIZE=1` opts out for hardened wrappers that sanitize downstream themselves).
