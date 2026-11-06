---
"@ag-bash/bash": patch
---

Language servers are now started on first use and closed by `Bash.destroy()`.

A `Bash` instance used to spawn `typescript-language-server` for TypeScript and JavaScript as soon as it was constructed, and never closed it. Code that creates many instances (test and fuzz suites, `fork()` and `speculate()` branches, sub-agents) therefore leaked a child process, its pipes and some heap per instance, which slows and bloats long runs. The servers are now declared at construction and spawned by the first LSP request that needs one (`bash.lsp.sendRequest`, the `ag_lsp` tool).

What changes for LSP users:

- The first request for a file type pays a cold start (roughly a quarter of a second with the real `typescript-language-server`) and now waits for the server's `initialize` reply before it is sent. Concurrent first requests share one start; later requests reuse the server.
- A server that never answers `initialize` leaves the first request waiting until `destroy()`. Before, such a request also never completed.
- A server that cannot be started (for example the binary is not installed) now falls back to the semantic engine. Before, the request never settled.
- `Bash.destroy()` closes every server the instance started (its stdio pipes are destroyed and it is sent SIGTERM) and settles in-flight requests: a request still waiting for the handshake falls back to the semantic engine, a request already sent to the server resolves with `null`.
- After `destroy()` the instance stays usable; the next LSP request starts a fresh server.
- Instances that share one injected `lspManager` (`new Bash({ services: { lspManager } })`) share its servers: destroying one settles the other's in-flight request, and the other's next request restarts the server.
- File-change notifications no longer start a server; they are forwarded only when one is already running.
- `ServiceContainer.dispose()` now also disposes the language-server manager.
