import { createHash } from "node:crypto";
import type { ScriptNode } from "../ast/types.js";

/**
 * ASTCache stores parsed ASTs for Bash scripts to avoid redundant parsing.
 */
export class ASTCache {
  private static instance: ASTCache;
  private cache: Map<string, { ast: ScriptNode; timestamp: number }> =
    new Map();
  private maxEntries = 100;
  private ttlMs = 3600000; // 1 hour

  private constructor() {}

  static getInstance(): ASTCache {
    if (!ASTCache.instance) {
      ASTCache.instance = new ASTCache();
    }
    return ASTCache.instance;
  }

  /**
   * Get the cache key for a given input string.
   */
  private getKey(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }

  /**
   * Get a cached AST.
   */
  get(input: string): ScriptNode | null {
    const key = this.getKey(input);
    const entry = this.cache.get(key);

    if (entry) {
      if (Date.now() - entry.timestamp < this.ttlMs) {
        return entry.ast;
      } else {
        this.cache.delete(key);
      }
    }

    return null;
  }

  /**
   * Store an AST in the cache.
   */
  set(input: string, ast: ScriptNode): void {
    const key = this.getKey(input);

    // Evict oldest if full
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, { ast, timestamp: Date.now() });
  }

  /**
   * Clear the cache.
   */
  clear(): void {
    this.cache.clear();
  }
}
