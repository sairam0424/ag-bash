import type { ToolboxTool } from "./Tool.js";

/**
 * A single search result with its relevance score and match source.
 */
export interface SearchResult {
  tool: ToolboxTool;
  /** Relevance score where lower is better (0 = exact name match). */
  score: number;
  /** Which field produced the best match for this tool. */
  matchedOn: "name" | "description" | "searchHint" | "alias";
}

/** Default maximum number of results returned by a search. */
const DEFAULT_LIMIT = 10;

/** Minimum token length to keep after splitting on whitespace. */
const MIN_TOKEN_LENGTH = 2;

/* ------------------------------------------------------------------ */
/*  Scoring constants                                                 */
/* ------------------------------------------------------------------ */

const SCORE_EXACT_NAME = 0;
const SCORE_FUZZY_NAME = 8;
const SCORE_NAME_CONTAINS = 10;
const SCORE_ALIAS_MATCH = 15;
const SCORE_SEARCH_HINT = 20;
const SCORE_DESCRIPTION = 30;

const FUZZY_MAX_DISTANCE = 2;

/** Bonus subtracted per additional keyword match (lower score = better). */
const MULTI_MATCH_BONUS = 2;

/**
 * Stateless keyword search engine with TF-IDF-style scoring for ToolboxTool
 * arrays. All state comes from the `tools` parameter -- the class holds no
 * mutable data between calls.
 *
 * Scoring algorithm (lower is better):
 *  1. Exact tool name match                        -> 0
 *  2. Tool name contains a query keyword            -> 10
 *  3. Alias matches a query keyword                 -> 15
 *  4. searchHint contains a keyword                 -> 20  (minus 2 per extra match)
 *  5. Description contains a keyword                -> 30  (minus 2 per extra match)
 *  6. Multiple keyword matches further reduce score
 */
export class ToolSearchEngine {
  /* ---------------------------------------------------------------- */
  /*  Public API                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Search tools by keyword query.
   *
   * @param tools  - The full tool collection to search against.
   * @param query  - Free-text query (split on whitespace into keywords).
   * @param limit  - Maximum number of results (default 10).
   * @returns Results sorted by relevance (best first, lowest score).
   */
  search(
    tools: ToolboxTool[],
    query: string,
    limit: number = DEFAULT_LIMIT,
  ): SearchResult[] {
    const keywords = this.tokenize(query);
    if (keywords.length === 0) {
      return [];
    }

    const results: SearchResult[] = [];

    for (const tool of tools) {
      const result = this.scoreTool(tool, keywords, query);
      if (result !== null) {
        results.push(result);
      }
    }

    // Sort ascending by score (lower = better match).
    results.sort((a, b) => a.score - b.score);

    return results.slice(0, limit);
  }

  /**
   * Direct select: find tools by exact name.
   *
   * Supports comma-separated names (the `select:Read,Edit,Grep` pattern).
   * The `select:` prefix is stripped automatically if present.
   *
   * @param tools - The full tool collection.
   * @param names - Comma-separated tool names, optionally prefixed with `select:`.
   * @returns Matched tools in the order they were requested (missing names are skipped).
   */
  selectByName(tools: ToolboxTool[], names: string): ToolboxTool[] {
    // Strip the "select:" prefix if the caller passed it through.
    const raw = names.startsWith("select:") ? names.slice(7) : names;

    const requested = raw
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter((n) => n.length > 0);

    if (requested.length === 0) {
      return [];
    }

    // Build a case-insensitive lookup map for O(1) access.
    const toolMap = new Map<string, ToolboxTool>();
    for (const tool of tools) {
      toolMap.set(tool.name.toLowerCase(), tool);
    }

    const matched: ToolboxTool[] = [];
    for (const name of requested) {
      const tool = toolMap.get(name);
      if (tool) {
        matched.push(tool);
      }
    }

    return matched;
  }

  /* ---------------------------------------------------------------- */
  /*  Internal helpers                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Tokenize a query string into lowercase keywords, filtering out tokens
   * shorter than {@link MIN_TOKEN_LENGTH} characters.
   */
  private tokenize(query: string): string[] {
    return query
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length >= MIN_TOKEN_LENGTH);
  }

  /**
   * Score a single tool against the given keywords.
   *
   * Returns `null` when no keyword matches any searchable field,
   * meaning the tool should be excluded from results entirely.
   */
  private scoreTool(
    tool: ToolboxTool,
    keywords: string[],
    rawQuery: string,
  ): SearchResult | null {
    const nameLower = tool.name.toLowerCase();
    const queryLower = rawQuery.toLowerCase().trim();

    // ---- 1. Exact name match (score 0) ---------------------------------
    if (nameLower === queryLower) {
      return { tool, score: SCORE_EXACT_NAME, matchedOn: "name" };
    }

    let bestScore = Infinity;
    let bestMatchedOn: SearchResult["matchedOn"] = "name";

    // ---- 2. Fuzzy name match (score 8) ----------------------------------
    if (this.levenshtein(queryLower, nameLower) <= FUZZY_MAX_DISTANCE) {
      bestScore = SCORE_FUZZY_NAME;
      bestMatchedOn = "name";
    }

    // ---- 3. Name contains any keyword (score 10) -----------------------
    for (const kw of keywords) {
      if (nameLower.includes(kw)) {
        if (SCORE_NAME_CONTAINS < bestScore) {
          bestScore = SCORE_NAME_CONTAINS;
          bestMatchedOn = "name";
        }
        break;
      }
    }

    // ---- 4. Alias match (score 15) -------------------------------------
    if (tool.aliases && tool.aliases.length > 0) {
      const aliasesLower = tool.aliases.map((a) => a.toLowerCase());

      for (const alias of aliasesLower) {
        if (alias === queryLower) {
          if (SCORE_ALIAS_MATCH < bestScore) {
            bestScore = SCORE_ALIAS_MATCH;
            bestMatchedOn = "alias";
          }
          break;
        }
        if (this.levenshtein(queryLower, alias) <= FUZZY_MAX_DISTANCE) {
          if (SCORE_FUZZY_NAME < bestScore) {
            bestScore = SCORE_FUZZY_NAME;
            bestMatchedOn = "alias";
          }
          break;
        }
        for (const kw of keywords) {
          if (alias.includes(kw)) {
            if (SCORE_ALIAS_MATCH < bestScore) {
              bestScore = SCORE_ALIAS_MATCH;
              bestMatchedOn = "alias";
            }
            break;
          }
        }
      }
    }

    // ---- 5. searchHint keyword match (score 20 - bonus) ----------------
    if (tool.searchHint) {
      const hintLower = tool.searchHint.toLowerCase();
      let matchCount = 0;

      for (const kw of keywords) {
        if (hintLower.includes(kw)) {
          matchCount++;
        }
      }

      if (matchCount > 0) {
        const hintScore =
          SCORE_SEARCH_HINT - (matchCount - 1) * MULTI_MATCH_BONUS;
        if (hintScore < bestScore) {
          bestScore = hintScore;
          bestMatchedOn = "searchHint";
        }
      }
    }

    // ---- 6. Description keyword match (score 30 - bonus) ---------------
    const descLower = tool.description.toLowerCase();
    let descMatchCount = 0;

    for (const kw of keywords) {
      if (descLower.includes(kw)) {
        descMatchCount++;
      }
    }

    if (descMatchCount > 0) {
      const descScore =
        SCORE_DESCRIPTION - (descMatchCount - 1) * MULTI_MATCH_BONUS;
      if (descScore < bestScore) {
        bestScore = descScore;
        bestMatchedOn = "description";
      }
    }

    // ---- No matches at all -> exclude ----------------------------------
    if (bestScore === Infinity) {
      return null;
    }

    return { tool, score: bestScore, matchedOn: bestMatchedOn };
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      Array(n + 1).fill(0),
    );
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }
}
