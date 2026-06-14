/**
 * Performance benchmarks for the ASTCache LRU + FNV-1a-64 keying.
 *
 * Contrasts the cache hit path (key hash + Map promote) against the
 * miss path (key hash + full re-parse), which is the value the cache
 * is meant to deliver on the exec hot path.
 *
 * Run: pnpm exec vitest bench --run src/parser/ASTCache.bench.ts
 */
import { bench, describe } from "vitest";
import { ASTCache } from "./ASTCache.js";
import { parse } from "./parser.js";

const SCRIPT = `for i in 1 2 3 4 5; do
  echo "item $i: $(date +%s)"
done
cat data.txt | grep foo | sort | uniq -c | head`;

// Pre-warm a cache holding the parsed AST for the hit-path bench.
const warmCache = new ASTCache();
warmCache.set(SCRIPT, parse(SCRIPT));

describe("ASTCache", () => {
  bench("get (hit) — cached AST returned", () => {
    warmCache.get(SCRIPT);
  });

  bench("get (miss) — key hash, no entry", () => {
    // A distinct key each call would defeat the point; use a fixed
    // never-inserted key so we measure the steady-state miss cost.
    warmCache.get("##never-inserted-key##");
  });

  bench("miss + reparse — realized cost of a cold key", () => {
    const cache = new ASTCache();
    let ast = cache.get(SCRIPT);
    if (ast === null) {
      ast = parse(SCRIPT);
      cache.set(SCRIPT, ast);
    }
  });

  bench("set — hash + insert + LRU eviction check", () => {
    const cache = new ASTCache();
    cache.configure({ maxEntries: 4 });
    cache.set(SCRIPT, parse(SCRIPT));
  });
});
