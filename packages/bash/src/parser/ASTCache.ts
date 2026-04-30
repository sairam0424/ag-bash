import type { ScriptNode } from "../ast/types.js";

interface ASTCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
}

interface ASTCacheStats {
  size: number;
  hits: number;
  misses: number;
}

/**
 * LRU cache for parsed Bash ASTs keyed by script source text.
 *
 * Uses FNV-1a hashing for fast, non-cryptographic cache key generation.
 * Inputs shorter than 64 characters are used directly as keys (no hashing).
 * Eviction follows true LRU order: accessed entries are promoted to the
 * tail of the internal Map, and the least-recently-used entry (head) is
 * evicted when the cache exceeds `maxEntries`. Entries older than `ttlMs`
 * are treated as missing and removed on access.
 *
 * Can be reconfigured at runtime via `configure()`.
 */
export class ASTCache {
  private cache: Map<string, { ast: ScriptNode; timestamp: number }> =
    new Map();
  private maxEntries = 100;
  private ttlMs = 3600000;
  private hits = 0;
  private misses = 0;

  configure(opts: ASTCacheOptions): void {
    if (opts.maxEntries !== undefined) {
      this.maxEntries = opts.maxEntries;
    }
    if (opts.ttlMs !== undefined) {
      this.ttlMs = opts.ttlMs;
    }
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private getKey(input: string): string {
    if (input.length < 64) {
      return input;
    }
    return fnv1a(input);
  }

  get(input: string): ScriptNode | null {
    const key = this.getKey(input);
    const entry = this.cache.get(key);

    if (entry) {
      if (Date.now() - entry.timestamp < this.ttlMs) {
        this.hits++;
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.ast;
      }
      this.cache.delete(key);
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

    this.cache.set(key, { ast, timestamp: Date.now() });
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

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) | 0;
  }
  return (hash >>> 0).toString(36);
}
