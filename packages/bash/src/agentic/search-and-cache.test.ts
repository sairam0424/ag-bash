import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolSearchEngine } from "./ToolSearchEngine.js";
import { buildTool } from "./Tool.js";
import { WebCache } from "../network/WebCache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal no-op execute for mock tools. */
const noop = async () => "ok";

/** Shorthand to build a mock tool with common defaults. */
function mockTool(overrides: {
  name: string;
  description: string;
  searchHint?: string;
  aliases?: string[];
}) {
  return buildTool({
    name: overrides.name,
    description: overrides.description,
    parameters: z.object({}),
    execute: noop,
    searchHint: overrides.searchHint,
    aliases: overrides.aliases,
  });
}

// ===========================================================================
// ToolSearchEngine
// ===========================================================================

describe("ToolSearchEngine", () => {
  const engine = new ToolSearchEngine();

  // Build a reusable set of mock tools.
  const tools = [
    mockTool({
      name: "Read",
      description: "Read a file from the filesystem",
      searchHint: "cat open view file contents",
      aliases: ["cat", "view"],
    }),
    mockTool({
      name: "Edit",
      description: "Edit an existing file with string replacement",
      searchHint: "modify change update patch replace text",
      aliases: ["patch"],
    }),
    mockTool({
      name: "Grep",
      description: "Search for patterns across files",
      searchHint: "find search regex pattern codebase",
      aliases: ["search", "rg"],
    }),
    mockTool({
      name: "WebFetch",
      description: "Fetch content from a URL on the internet",
      searchHint: "http download curl request api web",
      aliases: ["curl", "fetch"],
    }),
    mockTool({
      name: "NotebookEdit",
      description: "Edit cells in a Jupyter notebook",
      searchHint: "jupyter ipynb cell notebook python",
    }),
  ];

  // -----------------------------------------------------------------------
  // Exact name match (score 0)
  // -----------------------------------------------------------------------
  it("exact name match returns score 0", () => {
    const results = engine.search(tools, "Read");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].tool.name).toBe("Read");
    expect(results[0].score).toBe(0);
    expect(results[0].matchedOn).toBe("name");
  });

  // -----------------------------------------------------------------------
  // Name-contains match (score 10)
  // -----------------------------------------------------------------------
  it("name-contains returns score 10", () => {
    // "fetch" is contained in "WebFetch"
    const results = engine.search(tools, "fetch");
    const webFetchResult = results.find((r) => r.tool.name === "WebFetch");
    expect(webFetchResult).toBeDefined();
    // It should match on name-contains (10) or alias (15) — WebFetch has alias "fetch"
    // Alias exact match beats name-contains, but "fetch" also substring-matches the name
    // Name-contains (10) < Alias (15), so best score should be 10
    expect(webFetchResult!.score).toBe(10);
  });

  // -----------------------------------------------------------------------
  // searchHint keyword match (score ~20)
  // -----------------------------------------------------------------------
  it("searchHint keyword match returns score ~20", () => {
    // "regex" appears only in Grep's searchHint, not in its name or description
    const results = engine.search(tools, "regex");
    const grepResult = results.find((r) => r.tool.name === "Grep");
    expect(grepResult).toBeDefined();
    expect(grepResult!.score).toBe(20);
    expect(grepResult!.matchedOn).toBe("searchHint");
  });

  // -----------------------------------------------------------------------
  // Description-only match (score ~30)
  // -----------------------------------------------------------------------
  it("description-only match returns score ~30", () => {
    // "internet" appears only in WebFetch's description
    const results = engine.search(tools, "internet");
    const webFetchResult = results.find((r) => r.tool.name === "WebFetch");
    expect(webFetchResult).toBeDefined();
    expect(webFetchResult!.score).toBe(30);
    expect(webFetchResult!.matchedOn).toBe("description");
  });

  // -----------------------------------------------------------------------
  // Multi-keyword query boosts score (lower is better)
  // -----------------------------------------------------------------------
  it("multi-keyword query boosts score (lower)", () => {
    // Use keywords that only appear in Grep's searchHint, not in its
    // name or aliases, so the alias tier (15) does not dominate.
    // Grep searchHint: "find search regex pattern codebase"

    // Single keyword: "regex" in Grep's searchHint -> score 20
    const singleResult = engine.search(tools, "regex");
    const grepSingle = singleResult.find((r) => r.tool.name === "Grep");

    // Multi keyword: "regex pattern" — both appear in Grep's searchHint
    // Score = 20 - (2-1)*2 = 18
    const multiResult = engine.search(tools, "regex pattern");
    const grepMulti = multiResult.find((r) => r.tool.name === "Grep");

    expect(grepSingle).toBeDefined();
    expect(grepMulti).toBeDefined();
    expect(grepMulti!.score).toBeLessThan(grepSingle!.score);
  });

  // -----------------------------------------------------------------------
  // No matches returns empty array
  // -----------------------------------------------------------------------
  it("query with no matches returns empty array", () => {
    const results = engine.search(tools, "xyznonexistent");
    expect(results).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Limit parameter caps results
  // -----------------------------------------------------------------------
  it("limit parameter caps results", () => {
    // "file" appears in multiple tools' descriptions/hints — should match several
    const results = engine.search(tools, "file", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  // -----------------------------------------------------------------------
  // selectByName with "select:" prefix
  // -----------------------------------------------------------------------
  it("selectByName with 'select:tool1,tool2' pattern", () => {
    const selected = engine.selectByName(tools, "select:Read,Grep");
    expect(selected.length).toBe(2);
    expect(selected[0].name).toBe("Read");
    expect(selected[1].name).toBe("Grep");
  });

  // -----------------------------------------------------------------------
  // selectByName with bare comma-separated names
  // -----------------------------------------------------------------------
  it("selectByName with bare comma-separated names", () => {
    const selected = engine.selectByName(tools, "Edit,WebFetch");
    expect(selected.length).toBe(2);
    expect(selected[0].name).toBe("Edit");
    expect(selected[1].name).toBe("WebFetch");
  });

  // -----------------------------------------------------------------------
  // selectByName with nonexistent names returns empty
  // -----------------------------------------------------------------------
  it("selectByName with nonexistent names returns empty", () => {
    const selected = engine.selectByName(tools, "select:FooBar,BazQux");
    expect(selected).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Case insensitivity
  // -----------------------------------------------------------------------
  it("case insensitivity in search", () => {
    const lower = engine.search(tools, "read");
    const upper = engine.search(tools, "READ");
    const mixed = engine.search(tools, "ReAd");

    // All three queries should find the Read tool as the top result
    expect(lower[0].tool.name).toBe("Read");
    expect(upper[0].tool.name).toBe("Read");
    expect(mixed[0].tool.name).toBe("Read");

    // All should produce the same score
    expect(lower[0].score).toBe(upper[0].score);
    expect(upper[0].score).toBe(mixed[0].score);
  });

  it("case insensitivity in selectByName", () => {
    const selected = engine.selectByName(tools, "select:read,GREP,eDiT");
    expect(selected.length).toBe(3);
    expect(selected[0].name).toBe("Read");
    expect(selected[1].name).toBe("Grep");
    expect(selected[2].name).toBe("Edit");
  });
});

// ===========================================================================
// WebCache
// ===========================================================================

describe("WebCache", () => {
  // -----------------------------------------------------------------------
  // put() and get() round-trip
  // -----------------------------------------------------------------------
  it("put() and get() round-trip", () => {
    const cache = new WebCache();
    cache.put("https://example.com/data", "hello world", {
      contentType: "text/plain",
      statusCode: 200,
    });

    const entry = cache.get("https://example.com/data");
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("hello world");
    expect(entry!.contentType).toBe("text/plain");
    expect(entry!.statusCode).toBe(200);
  });

  // -----------------------------------------------------------------------
  // get() returns null for missing URL
  // -----------------------------------------------------------------------
  it("get() returns null for missing URL", () => {
    const cache = new WebCache();
    const entry = cache.get("https://example.com/missing");
    expect(entry).toBeNull();
  });

  // -----------------------------------------------------------------------
  // get() returns null for expired entry
  // -----------------------------------------------------------------------
  it("get() returns null for expired entry", async () => {
    const cache = new WebCache();
    cache.put("https://example.com/ephemeral", "temp data", {
      ttlMs: 1, // 1ms TTL
    });

    // Wait a small amount for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    const entry = cache.get("https://example.com/ephemeral");
    expect(entry).toBeNull();
  });

  // -----------------------------------------------------------------------
  // has() returns true for cached, false for missing
  // -----------------------------------------------------------------------
  it("has() returns true for cached, false for missing", () => {
    const cache = new WebCache();
    cache.put("https://example.com/present", "data");

    expect(cache.has("https://example.com/present")).toBe(true);
    expect(cache.has("https://example.com/absent")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // invalidate() removes entry
  // -----------------------------------------------------------------------
  it("invalidate() removes entry", () => {
    const cache = new WebCache();
    cache.put("https://example.com/remove-me", "data");

    expect(cache.has("https://example.com/remove-me")).toBe(true);

    const removed = cache.invalidate("https://example.com/remove-me");
    expect(removed).toBe(true);
    expect(cache.has("https://example.com/remove-me")).toBe(false);

    // Invalidating a nonexistent key returns false
    const removedAgain = cache.invalidate("https://example.com/remove-me");
    expect(removedAgain).toBe(false);
  });

  // -----------------------------------------------------------------------
  // clear() removes all entries
  // -----------------------------------------------------------------------
  it("clear() removes all entries", () => {
    const cache = new WebCache();
    cache.put("https://a.com", "a");
    cache.put("https://b.com", "b");
    cache.put("https://c.com", "c");

    expect(cache.stats().entries).toBe(3);

    cache.clear();

    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().totalSizeBytes).toBe(0);
    expect(cache.stats().hitCount).toBe(0);
    expect(cache.stats().missCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // stats() tracks hits and misses correctly
  // -----------------------------------------------------------------------
  it("stats() tracks hits and misses correctly", () => {
    const cache = new WebCache();
    cache.put("https://example.com/hit", "data");

    // 2 hits via get() and has()
    cache.get("https://example.com/hit");
    cache.has("https://example.com/hit");

    // 3 misses via get() on missing, has() on missing, get() on invalid
    cache.get("https://example.com/miss1");
    cache.has("https://example.com/miss2");
    cache.get("https://example.com/miss3");

    const s = cache.stats();
    expect(s.hitCount).toBe(2);
    expect(s.missCount).toBe(3);
  });

  // -----------------------------------------------------------------------
  // URL normalization: different casing and trailing slash hit same key
  // -----------------------------------------------------------------------
  it("URL normalization: case and trailing slash collapse to same key", () => {
    const cache = new WebCache();
    cache.put("https://Example.COM/path/", "normalized content", {
      contentType: "text/html",
    });

    // Fetch with lowercase and no trailing slash on root
    // Note: /path/ is NOT root-only, so the trailing slash is preserved by
    // URL normalization. Both forms normalize to the same href.
    const entry = cache.get("https://example.com/path/");
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("normalized content");

    // Root URL normalization: trailing slash removed
    cache.put("https://Example.COM/", "root content");
    const rootEntry = cache.get("https://example.com");
    expect(rootEntry).not.toBeNull();
    expect(rootEntry!.content).toBe("root content");
  });

  // -----------------------------------------------------------------------
  // LRU eviction: oldest entry evicted when maxCacheSizeBytes exceeded
  // -----------------------------------------------------------------------
  it("LRU eviction: oldest entry is evicted when size budget exceeded", () => {
    // Each character = 2 bytes in the approximation.
    // 10-char string = 20 bytes.
    // Set max to 50 bytes: can hold 2 entries of 10 chars (40 bytes),
    // but adding a 3rd should evict the oldest.
    const cache = new WebCache({ maxCacheSizeBytes: 50 });

    cache.put("https://a.com", "aaaaaaaaaa"); // 20 bytes
    cache.put("https://b.com", "bbbbbbbbbb"); // 20 bytes (total: 40)
    cache.put("https://c.com", "cccccccccc"); // 20 bytes -> evicts "a" to fit

    // "a" should have been evicted (oldest by insertion)
    expect(cache.get("https://a.com")).toBeNull();
    // "b" and "c" should remain
    expect(cache.get("https://b.com")).not.toBeNull();
    expect(cache.get("https://c.com")).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // put() updates existing entry (re-caches)
  // -----------------------------------------------------------------------
  it("put() updates existing entry (re-caches)", () => {
    const cache = new WebCache();
    cache.put("https://example.com/update", "version 1");
    cache.put("https://example.com/update", "version 2");

    const entry = cache.get("https://example.com/update");
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("version 2");

    // Only one entry should exist
    expect(cache.stats().entries).toBe(1);
  });
});
