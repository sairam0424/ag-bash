import type { ScriptNode } from "../ast/types.js";

interface ASTCacheOptions {
  maxEntries?: number;
}

interface ASTCacheStats {
  size: number;
  hits: number;
  misses: number;
  /** Key matches rejected because the stored source differed (see verify-on-hit). */
  collisions: number;
}

/** A cached AST paired with the exact source it was parsed from. */
interface ASTCacheEntry {
  readonly source: string;
  readonly ast: ScriptNode;
}

/**
 * LRU cache for parsed Bash ASTs keyed by script source text.
 *
 * Correctness does NOT rest on the hash: every entry stores the source it was
 * parsed from, and `get()` verifies that source on a key match (verify-on-hit).
 * A key match whose source differs is reported as a miss, so the caller
 * re-parses. Without that check a hash collision would hand back the WRONG
 * parsed program and the interpreter would execute a script it was never
 * given — a correctness bug, not a cache-efficiency one. Widening the hash
 * only makes such a collision rarer; verifying makes it harmless.
 *
 * Keys come from a 64-bit FNV-1a digest (two independent 32-bit FNV-1a
 * streams, each seeded with a different offset basis, concatenated) prefixed
 * with the input length. That is purely a bucketing/perf concern now: a
 * collision costs one re-parse instead of returning bad output. Hashing is
 * synchronous and dependency-free because `getKey()` runs on the parse hot
 * path and must never await.
 *
 * Memory trade-off: retaining the source pins one extra string per entry, so
 * the footprint is bounded by `maxEntries` x script length (default 1000
 * entries). This is marginal against what the AST already holds — a parsed
 * 68-char script measured ~26x its source in node structure, and
 * `StatementNode.sourceText` already retains the full source as per-statement
 * slices — so an entry roughly keeps a copy it was already keeping. Cheaper
 * discriminators (a second hash, a length+prefix sample) were rejected:
 * anything that can itself collide just relocates the bug.
 *
 * Eviction follows true LRU order: accessed entries are promoted to the
 * tail of the internal Map, and the least-recently-used entry (head) is
 * evicted when the cache exceeds `maxEntries` (default 1000).
 *
 * Can be reconfigured at runtime via `configure()`.
 */
export class ASTCache {
  private cache: Map<string, ASTCacheEntry> = new Map();
  private maxEntries = 1000;
  private hits = 0;
  private misses = 0;
  private collisions = 0;

  configure(opts: ASTCacheOptions): void {
    if (opts.maxEntries !== undefined) {
      this.maxEntries = opts.maxEntries;
    }
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private getKey(input: string): string {
    return `${input.length}:${fnv1a64(input)}`;
  }

  get(input: string): ScriptNode | null {
    const key = this.getKey(input);
    const entry = this.cache.get(key);

    if (entry !== undefined) {
      if (entry.source === input) {
        this.hits++;
        // Promote to tail for LRU ordering
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.ast;
      }
      // Verify-on-hit failed: the key matched but this is a different script.
      // Returning entry.ast would execute the wrong program, so report a miss
      // and let the caller re-parse. The stale entry is left for its rightful
      // owner; a following set() for this input replaces it.
      this.collisions++;
    }

    this.misses++;
    return null;
  }

  set(input: string, ast: ScriptNode): void {
    const key = this.getKey(input);

    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }

    this.cache.set(key, { source: input, ast });
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.collisions = 0;
  }

  stats(): ASTCacheStats {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      collisions: this.collisions,
    };
  }
}

/**
 * 64-bit FNV-1a digest built from two independent 32-bit FNV-1a streams.
 *
 * Each stream uses the standard FNV-1a step (xor byte, multiply by the
 * 32-bit FNV prime) but starts from a different offset basis so the two
 * 32-bit halves are decorrelated. They are concatenated into a single
 * 16-hex-char (64-bit) string, dramatically lowering collision probability
 * versus a single 32-bit hash. Pure JS, synchronous, dependency-free.
 *
 * The 32-bit multiply uses `Math.imul` for correct wraparound arithmetic.
 */
function fnv1a64(input: string): string {
  // Standard FNV-1a 32-bit offset basis for the low word.
  let low = 0x811c9dc5;
  // A distinct seed for the high word so the two streams are independent.
  let high = 0x01000193;
  const prime = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    low ^= code;
    low = Math.imul(low, prime);
    high ^= code;
    high = Math.imul(high, prime);
    // Cross-feed a rotated byte into the high stream so it diverges from low.
    high ^= (code << 8) | (code >>> 8);
  }
  const lowHex = (low >>> 0).toString(16).padStart(8, "0");
  const highHex = (high >>> 0).toString(16).padStart(8, "0");
  return `${highHex}${lowHex}`;
}
