import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASTCache } from "./ASTCache.js";
import type { ScriptNode } from "../ast/types.js";

/**
 * Unit tests for ASTCache — LRU cache with FNV-1a hashing and length-prefixed keys.
 */

function makeAST(id = 1): ScriptNode {
  return { type: "Script", statements: [{ type: "Statement", pipelines: [], operators: [], background: false, sourceText: `cmd${id}` }] };
}

function makeLongInput(length: number): string {
  return "x".repeat(length);
}

describe("ASTCache", () => {
  let cache: ASTCache;

  beforeEach(() => {
    cache = new ASTCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic get/set operations", () => {
    it("should return null for cache miss", () => {
      expect(cache.get("echo hello")).toBeNull();
    });

    it("should return stored AST for cache hit", () => {
      const ast = makeAST();
      cache.set("echo hello", ast);
      expect(cache.get("echo hello")).toBe(ast);
    });

    it("should store and retrieve multiple entries", () => {
      const ast1 = makeAST(1);
      const ast2 = makeAST(2);
      cache.set("echo one", ast1);
      cache.set("echo two", ast2);
      expect(cache.get("echo one")).toBe(ast1);
      expect(cache.get("echo two")).toBe(ast2);
    });

    it("should overwrite existing entry with same key", () => {
      const ast1 = makeAST(1);
      const ast2 = makeAST(2);
      cache.set("echo hello", ast1);
      cache.set("echo hello", ast2);
      expect(cache.get("echo hello")).toBe(ast2);
    });
  });

  describe("short-circuit for inputs < 64 chars", () => {
    it("should use input directly as key for short strings", () => {
      const shortInput = "ls -la"; // 6 chars
      const ast = makeAST();
      cache.set(shortInput, ast);
      expect(cache.get(shortInput)).toBe(ast);
    });

    it("should use input directly as key for 63-char input", () => {
      const input63 = "a".repeat(63);
      const ast = makeAST();
      cache.set(input63, ast);
      expect(cache.get(input63)).toBe(ast);
    });

    it("should hash 64-char input (boundary condition)", () => {
      const input64 = "b".repeat(64);
      const ast = makeAST();
      cache.set(input64, ast);
      expect(cache.get(input64)).toBe(ast);
    });

    it("should hash long inputs and still retrieve correctly", () => {
      const longInput = makeLongInput(200);
      const ast = makeAST();
      cache.set(longInput, ast);
      expect(cache.get(longInput)).toBe(ast);
    });
  });

  describe("FNV-1a hash consistency", () => {
    it("should produce same cache hit for identical long inputs", () => {
      const input = makeLongInput(100);
      const ast = makeAST();
      cache.set(input, ast);
      // Getting with an identical string must hit
      const identicalInput = makeLongInput(100);
      expect(cache.get(identicalInput)).toBe(ast);
    });

    it("should produce different keys for different long inputs", () => {
      const input1 = "a".repeat(100);
      const input2 = "b".repeat(100);
      const ast1 = makeAST(1);
      const ast2 = makeAST(2);
      cache.set(input1, ast1);
      cache.set(input2, ast2);
      expect(cache.get(input1)).toBe(ast1);
      expect(cache.get(input2)).toBe(ast2);
    });

    it("should differentiate inputs that differ by one character", () => {
      const input1 = "a".repeat(64) + "x";
      const input2 = "a".repeat(64) + "y";
      const ast1 = makeAST(1);
      const ast2 = makeAST(2);
      cache.set(input1, ast1);
      cache.set(input2, ast2);
      expect(cache.get(input1)).toBe(ast1);
      expect(cache.get(input2)).toBe(ast2);
    });
  });

  describe("LRU eviction", () => {
    it("should evict oldest entry when capacity is exceeded", () => {
      cache.configure({ maxEntries: 3 });
      cache.set("a", makeAST(1));
      cache.set("b", makeAST(2));
      cache.set("c", makeAST(3));
      cache.set("d", makeAST(4)); // Should evict "a"
      expect(cache.get("a")).toBeNull();
      expect(cache.get("b")).not.toBeNull();
      expect(cache.get("c")).not.toBeNull();
      expect(cache.get("d")).not.toBeNull();
    });

    it("should promote accessed entries (not evict recently accessed)", () => {
      cache.configure({ maxEntries: 3 });
      cache.set("a", makeAST(1));
      cache.set("b", makeAST(2));
      cache.set("c", makeAST(3));
      // Access "a" to promote it
      cache.get("a");
      // Now insert "d" — "b" should be evicted (oldest not accessed)
      cache.set("d", makeAST(4));
      expect(cache.get("a")).not.toBeNull();
      expect(cache.get("b")).toBeNull();
      expect(cache.get("c")).not.toBeNull();
      expect(cache.get("d")).not.toBeNull();
    });

    it("should evict multiple entries if capacity is reduced via configure", () => {
      cache.set("a", makeAST(1));
      cache.set("b", makeAST(2));
      cache.set("c", makeAST(3));
      cache.set("d", makeAST(4));
      cache.configure({ maxEntries: 2 });
      // "a" and "b" should be evicted (oldest two)
      expect(cache.get("a")).toBeNull();
      expect(cache.get("b")).toBeNull();
      expect(cache.stats().size).toBeLessThanOrEqual(2);
    });

    it("should respect maxEntries of 1", () => {
      cache.configure({ maxEntries: 1 });
      cache.set("a", makeAST(1));
      cache.set("b", makeAST(2));
      expect(cache.get("a")).toBeNull();
      expect(cache.get("b")).not.toBeNull();
      expect(cache.stats().size).toBe(1);
    });
  });

  describe("no TTL — entries persist until LRU eviction", () => {
    it("should retain entries regardless of elapsed time", () => {
      const ast = makeAST();
      cache.set("echo hello", ast);
      vi.advanceTimersByTime(999999999);
      expect(cache.get("echo hello")).toBe(ast);
    });

    it("should only evict via LRU when at capacity", () => {
      cache.configure({ maxEntries: 2 });
      cache.set("a", makeAST(1));
      cache.set("b", makeAST(2));
      vi.advanceTimersByTime(999999999);
      // Both still present — no TTL eviction
      expect(cache.get("a")).not.toBeNull();
      expect(cache.get("b")).not.toBeNull();
      // Inserting a third triggers LRU eviction of "a" (promoted "b" via get above)
      cache.set("c", makeAST(3));
      expect(cache.get("a")).toBeNull();
    });
  });

  describe("cache hit/miss stats", () => {
    it("should start with zero hits and misses", () => {
      const stats = cache.stats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.size).toBe(0);
    });

    it("should increment misses on cache miss", () => {
      cache.get("nonexistent");
      expect(cache.stats().misses).toBe(1);
      expect(cache.stats().hits).toBe(0);
    });

    it("should increment hits on cache hit", () => {
      cache.set("a", makeAST());
      cache.get("a");
      expect(cache.stats().hits).toBe(1);
      expect(cache.stats().misses).toBe(0);
    });

    it("should track size correctly", () => {
      cache.set("a", makeAST(1));
      cache.set("b", makeAST(2));
      expect(cache.stats().size).toBe(2);
    });

    it("should count evicted entry access as a miss", () => {
      cache.configure({ maxEntries: 1 });
      cache.set("a", makeAST());
      cache.set("b", makeAST(2)); // evicts "a"
      cache.get("a");
      expect(cache.stats().misses).toBe(1);
      expect(cache.stats().hits).toBe(0);
    });

    it("should accumulate multiple hits and misses", () => {
      cache.set("a", makeAST());
      cache.get("a"); // hit
      cache.get("a"); // hit
      cache.get("b"); // miss
      cache.get("c"); // miss
      cache.get("a"); // hit
      expect(cache.stats().hits).toBe(3);
      expect(cache.stats().misses).toBe(2);
    });
  });

  describe("clear()", () => {
    it("should remove all entries", () => {
      cache.set("a", makeAST(1));
      cache.set("b", makeAST(2));
      cache.clear();
      expect(cache.stats().size).toBe(0);
      expect(cache.get("a")).toBeNull();
      expect(cache.get("b")).toBeNull();
    });

    it("should reset hit/miss counters", () => {
      cache.set("a", makeAST());
      cache.get("a"); // hit
      cache.get("b"); // miss
      cache.clear();
      expect(cache.stats().hits).toBe(0);
      expect(cache.stats().misses).toBe(0);
    });
  });

  describe("configure() runtime reconfiguration", () => {
    it("should update maxEntries", () => {
      cache.configure({ maxEntries: 5 });
      for (let i = 0; i < 6; i++) {
        cache.set(`key${i}`, makeAST(i));
      }
      expect(cache.stats().size).toBe(5);
    });

    it("should retain entries after reconfiguration if within capacity", () => {
      cache.set("a", makeAST());
      cache.configure({ maxEntries: 500 });
      expect(cache.get("a")).not.toBeNull();
    });

    it("should evict excess entries immediately on capacity reduction", () => {
      for (let i = 0; i < 10; i++) {
        cache.set(`key${i}`, makeAST(i));
      }
      cache.configure({ maxEntries: 3 });
      expect(cache.stats().size).toBe(3);
    });
  });

  describe("concurrent access patterns", () => {
    it("should handle rapid set/get cycles", () => {
      cache.configure({ maxEntries: 100 });
      for (let i = 0; i < 200; i++) {
        cache.set(`key${i}`, makeAST(i));
      }
      // Last 100 should be present
      for (let i = 100; i < 200; i++) {
        expect(cache.get(`key${i}`)).not.toBeNull();
      }
      // First 100 should be evicted
      for (let i = 0; i < 100; i++) {
        expect(cache.get(`key${i}`)).toBeNull();
      }
    });

    it("should handle interleaved get/set operations correctly", () => {
      cache.configure({ maxEntries: 3 });
      cache.set("a", makeAST(1));
      cache.set("b", makeAST(2));
      cache.get("a"); // promote a
      cache.set("c", makeAST(3));
      cache.get("a"); // promote a again
      cache.set("d", makeAST(4)); // evicts b
      cache.set("e", makeAST(5)); // evicts c
      expect(cache.get("a")).not.toBeNull(); // Still there (promoted twice)
      expect(cache.get("b")).toBeNull();
      expect(cache.get("c")).toBeNull();
      expect(cache.get("d")).not.toBeNull();
      expect(cache.get("e")).not.toBeNull();
    });

    it("should handle set with same key repeatedly", () => {
      cache.configure({ maxEntries: 3 });
      cache.set("x", makeAST(1));
      cache.set("y", makeAST(2));
      cache.set("x", makeAST(3)); // Overwrite x
      cache.set("z", makeAST(4));
      cache.set("w", makeAST(5)); // Should evict y (x was refreshed)
      expect(cache.get("x")).not.toBeNull();
      expect(cache.get("y")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("should handle empty string as key", () => {
      const ast = makeAST();
      cache.set("", ast);
      expect(cache.get("")).toBe(ast);
    });

    it("should handle special characters in key", () => {
      const ast = makeAST();
      cache.set("echo $HOME; ls | grep 'foo'", ast);
      expect(cache.get("echo $HOME; ls | grep 'foo'")).toBe(ast);
    });

    it("should handle unicode in key", () => {
      const ast = makeAST();
      cache.set("echo '\u{1F600}\u{1F680}\u{2603}'", ast);
      expect(cache.get("echo '\u{1F600}\u{1F680}\u{2603}'")).toBe(ast);
    });
  });
});
