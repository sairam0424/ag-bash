import type { Bash } from "@ag-bash/bash";
import type { McpToolResult } from "./tool-bridge.js";

/** Default number of search results returned to the agent. */
const DEFAULT_LIMIT = 5;
/** Upper bound on results to keep responses token-bounded. */
const MAX_LIMIT = 25;

/** A single tool match surfaced to the agent. */
export interface ToolMatch {
  name: string;
  description: string;
}

/** Structured payload for the search_tools tool. */
export interface SearchToolsSummary {
  query: string;
  matches: ToolMatch[];
}

/**
 * Clamp a requested result limit into the supported range.
 */
function clampLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  const floored = Math.floor(raw);
  if (floored < 1) return 1;
  if (floored > MAX_LIMIT) return MAX_LIMIT;
  return floored;
}

/**
 * search_tools — Code Mode thin slice.
 *
 * Lets an agent discover which toolbox tools are available for a free-text
 * task description, instead of pre-loading the full ~40-tool catalog. Wraps the
 * engine's `BashToolbox.searchTools` (backed by `ToolSearchEngine`) so the same
 * relevance scoring used everywhere else is exposed over MCP.
 *
 * Returns a {@link SearchToolsSummary} (also serialized into the text block for
 * legacy clients).
 *
 * @param bash - The persistent shell whose toolbox is searched.
 * @param args - Raw JSON-RPC tool arguments: `{ query: string, limit?: number }`.
 */
export async function runSearchTools(
  bash: Bash,
  args: unknown,
): Promise<McpToolResult> {
  const a = (args ?? Object.create(null)) as { query?: unknown; limit?: unknown };
  const query = typeof a.query === "string" ? a.query.trim() : "";

  if (query.length === 0) {
    return {
      content: [
        { type: "text", text: "Error: 'query' must be a non-empty string." },
      ],
      isError: true,
    };
  }

  const limit = clampLimit(a.limit);
  const tools = await bash.toolbox.searchTools(query, limit);

  const summary: SearchToolsSummary = {
    query,
    matches: tools.map((t) => ({
      name: t.name,
      description: t.description,
    })),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
  };
}
