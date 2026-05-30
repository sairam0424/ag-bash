import type { ScriptNode } from "../ast/types.js";

interface ASTCacheOptions {
  maxEntries?: number;
}

interface ASTCacheStats {
  size: number;
  hits: number;
  misses: number;
}

/**
 * LRU cache for parsed Bash ASTs keyed by script source text.
 *
 * Uses a 64-bit FNV-1a hash for fast, non-cryptographic cache key generation.
 * The 64-bit width is computed as two independent 32-bit FNV-1a streams (each
 * seeded with a different offset basis) combined into a 16-hex-char digest,
 * making collisions astronomically unlikely compared to a single 32-bit hash
 * (a 32-bit hash returns the WRONG parsed program on collision — a correctness
 * bug). All inputs are hashed uniformly; the key includes the input length as
 * a prefix for additional disambiguation. Hashing is fully synchronous and
 * dependency-free because `getKey()` runs on the parse hot path and must never
 * await.
 *
 * Eviction follows true LRU order: accessed entries are promoted to the
 * tail of the internal Map, and the least-recently-used entry (head) is
 * evicted when the cache exceeds `maxEntries` (default 1000).
 *
 * Can be reconfigured at runtime via `configure()`.
 */
export class ASTCache {
  private cache: Map<string, ScriptNode> = new Map();
  private maxEntries = 1000;
  private hits = 0;
  private misses = 0;

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
    const ast = this.cache.get(key);

    if (ast) {
      this.hits++;
      // Promote to tail for LRU ordering
      this.cache.delete(key);
      this.cache.set(key, ast);
      return ast;
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

    this.cache.set(key, ast);
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats(): ASTCacheStats {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
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
