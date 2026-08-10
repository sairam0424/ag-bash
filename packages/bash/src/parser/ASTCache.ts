import type { ScriptNode } from "../ast/types.js";

interface ASTCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  maxMemoryBytes?: number;
}

interface ASTCacheStats {
  size: number;
  hits: number;
  misses: number;
  memoryEstimate: number;
}

interface CacheEntry {
  ast: ScriptNode;
  timestamp: number;
  sizeBytes: number;
}

/** Estimated average bytes per AST node (object overhead + properties). */
const BYTES_PER_NODE = 200;

/** Default memory cap: 50 MB. */
const DEFAULT_MAX_MEMORY_BYTES = 52428800;

/**
 * LRU cache for parsed Bash ASTs keyed by script source text.
 *
 * Uses FNV-1a hashing for fast, non-cryptographic cache key generation.
 * Inputs shorter than 64 characters are used directly as keys (no hashing).
 * Eviction follows true LRU order: accessed entries are promoted to the
 * tail of the internal Map, and the least-recently-used entry (head) is
 * evicted when the cache exceeds `maxEntries` or `maxMemoryBytes`.
 * Entries older than `ttlMs` are treated as missing and removed on access.
 *
 * Can be reconfigured at runtime via `configure()`.
 */
export class ASTCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxEntries = 1000;
  private maxMemoryBytes = DEFAULT_MAX_MEMORY_BYTES;
  private ttlMs = 3600000;
  private hits = 0;
  private misses = 0;
  private estimatedBytes = 0;

  configure(opts: ASTCacheOptions): void {
    if (opts.maxEntries !== undefined) {
      this.maxEntries = opts.maxEntries;
    }
    if (opts.ttlMs !== undefined) {
      this.ttlMs = opts.ttlMs;
    }
    if (opts.maxMemoryBytes !== undefined) {
      this.maxMemoryBytes = opts.maxMemoryBytes;
    }
    // Evict entries that exceed the new limits
    while (this.cache.size > this.maxEntries) {
      this.evictOldest();
    }
    while (this.estimatedBytes > this.maxMemoryBytes && this.cache.size > 0) {
      this.evictOldest();
    }
  }

  private getKey(input: string): string {
    if (input.length < 64) {
      return input;
    }
    return fnv1a(input);
  }

  /**
   * Estimate the memory footprint of an AST by counting nodes
   * and multiplying by a per-node byte estimate.
   */
  private estimateNodeSize(ast: ScriptNode): number {
    let count = 0;
    const stack: unknown[] = [ast];

    while (stack.length > 0) {
      const node = stack.pop();
      if (node === null || node === undefined) {
        continue;
      }
      if (typeof node !== "object") {
        continue;
      }
      // Check if this looks like an AST node (has a "type" string property)
      const record = node as Record<string, unknown>;
      if (typeof record.type === "string") {
        count++;
      }
      // Walk arrays and object values to find child nodes
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          stack.push(node[i]);
        }
      } else {
        const keys = Object.keys(record);
        for (let i = 0; i < keys.length; i++) {
          const value = record[keys[i]];
          if (typeof value === "object" && value !== null) {
            stack.push(value);
          }
        }
      }
    }

    return count * BYTES_PER_NODE;
  }

  get(input: string): ScriptNode | null {
    const key = this.getKey(input);
    const entry = this.cache.get(key);

    if (entry) {
      if (Date.now() - entry.timestamp < this.ttlMs) {
        this.hits++;
        // Promote to tail (most recently used)
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.ast;
      }
      // TTL expired - remove
      this.estimatedBytes -= entry.sizeBytes;
      this.cache.delete(key);
    }

    this.misses++;
    return null;
  }

  set(input: string, ast: ScriptNode): void {
    const key = this.getKey(input);
    const newEntrySize = this.estimateNodeSize(ast);

    // If key already exists, remove old entry first
    const existing = this.cache.get(key);
    if (existing) {
      this.estimatedBytes -= existing.sizeBytes;
      this.cache.delete(key);
    }

    // Evict LRU entries until we have room (entry count)
    while (this.cache.size >= this.maxEntries) {
      this.evictOldest();
    }

    // Evict LRU entries until we have room (memory budget)
    while (
      this.estimatedBytes + newEntrySize > this.maxMemoryBytes &&
      this.cache.size > 0
    ) {
      this.evictOldest();
    }

    this.cache.set(key, { ast, timestamp: Date.now(), sizeBytes: newEntrySize });
    this.estimatedBytes += newEntrySize;
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.estimatedBytes = 0;
  }

  stats(): ASTCacheStats {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      memoryEstimate: this.estimatedBytes,
    };
  }

  /**
   * Evict the least-recently-used entry (head of the Map).
   */
  private evictOldest(): void {
    const oldest = this.cache.keys().next().value;
    if (oldest !== undefined) {
      const entry = this.cache.get(oldest);
      if (entry) {
        this.estimatedBytes -= entry.sizeBytes;
      }
      this.cache.delete(oldest);
    }
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
