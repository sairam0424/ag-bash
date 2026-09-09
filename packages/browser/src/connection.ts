import type { Bash, CommandContext } from "@ag-bash/bash";

/**
 * Connection id used for the browser-harness MCP server on a Bash
 * instance's `mcpClient`, matching the id this host's own MCP-server
 * registration (`~/.claude.json` `mcpServers.browser-harness`) uses for the
 * identical stdio invocation.
 */
export const BROWSER_HARNESS_CONNECTION_ID = "browser-harness";

/**
 * In-flight (or completed) connect promises, keyed by Bash instance, so
 * concurrent ag_browser_* calls on the same shell share one connection
 * attempt instead of racing to spawn duplicate browser-harness-mcp
 * processes.
 */
const connecting = new WeakMap<Bash, Promise<void>>();

/**
 * Lazily connect the given Bash instance's MCP client to the
 * browser-harness MCP server: `uvx --from "browser-harness[mcp]"
 * browser-harness-mcp` — the exact stdio invocation browser-harness
 * documents (and this host already registers) for MCP clients. Idempotent:
 * a call while a connection exists (or is in flight) reuses it instead of
 * spawning a second process.
 *
 * Uses a 60s per-call timeout (vs. McpClient's 30s default): browser
 * navigation and screenshot actions routinely exceed the default, which is
 * sized for quick tool calls, not page loads.
 */
export async function ensureBrowserHarnessConnection(
  bash: Bash,
): Promise<void> {
  const already = bash.services.mcpClient
    .listConnections()
    .some((connection) => connection.id === BROWSER_HARNESS_CONNECTION_ID);
  if (already) return;

  let pending = connecting.get(bash);
  if (!pending) {
    // connectStdio only reads `cmdCtx.bash`; the rest of CommandContext
    // (fs, cwd, env, stdin) is irrelevant to spawning an MCP server, so a
    // minimal synthetic context is used rather than fabricating a full
    // shell context.
    const cmdCtx = { bash } as unknown as CommandContext;
    pending = bash.services.mcpClient
      .connectStdio(
        BROWSER_HARNESS_CONNECTION_ID,
        "uvx",
        ["--from", "browser-harness[mcp]", "browser-harness-mcp"],
        cmdCtx,
        { requestTimeoutMs: 60_000 },
      )
      .then(
        () => undefined,
        (error: unknown) => {
          // A failed attempt must not be cached forever: clear the
          // in-flight entry so the NEXT call retries (spawns a fresh
          // connectStdio) instead of permanently re-throwing this same
          // stale rejection for the rest of the Bash instance's
          // lifetime. Concurrent callers that were already awaiting
          // this same `pending` promise still observe the rejection
          // (that's the correct dedupe behavior for a shared in-flight
          // attempt) — only *future* calls get a fresh attempt.
          connecting.delete(bash);
          throw error;
        },
      );
    connecting.set(bash, pending);
  }
  await pending;
}
