/**
 * WebCache — URL content caching with TTL-based expiration and LRU eviction.
 *
 * Provides an in-memory cache for fetched URL content with configurable
 * time-to-live and maximum size constraints. Entries are evicted in
 * oldest-first (LRU-style by insertion time) order when the cache
 * exceeds its configured size budget.
 *
 * Designed to be sandbox-safe: no Node.js-specific APIs are used for
 * size estimation — content size is approximated using UTF-16 char width.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single cached response for a URL.
 */
export interface CacheEntry {
  /** The normalized URL used as the cache key. */
  url: string;
  /** The response body content. */
  content: string;
  /** MIME type of the cached content (e.g. "text/html"). */
  contentType: string;
  /** HTTP status code of the original response. */
  statusCode: number;
  /** Timestamp (ms since epoch) when this entry was stored. */
  cachedAt: number;
  /** Time-to-live in milliseconds for this specific entry. */
  ttlMs: number;
  /** Approximate size of `content` in bytes. */
  sizeBytes: number;
}

/**
 * Configuration options for the WebCache instance.
 */
export interface WebCacheOptions {
  /**
   * Default time-to-live in milliseconds for cached entries.
   * Individual entries can override this value.
   * @default 900_000 (15 minutes)
   */
  defaultTtlMs?: number;

  /**
   * Maximum total size of cached content in bytes.
   * When exceeded, the oldest entries are evicted first.
   * @default 52_428_800 (50 MB)
   */
  maxCacheSizeBytes?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Default TTL: 15 minutes. */
const DEFAULT_TTL_MS = 900_000;

/** Default max cache size: 50 MB. */
const DEFAULT_MAX_CACHE_SIZE_BYTES = 52_428_800;

/**
 * Approximate byte size of a string using UTF-16 character width.
 *
 * This avoids a dependency on `Buffer.byteLength` which is not available
 * in all sandbox runtimes. Each JS char is stored as a 16-bit code unit,
 * so `length * 2` is a reasonable upper-bound approximation.
 */
function approximateByteSize(content: string): number {
  return content.length * 2;
}

/**
 * Normalize a URL for use as a cache key.
 *
 * Normalization steps:
 *  1. Parse with the URL constructor (validates structure).
 *  2. Lowercase the hostname (URL constructor already does this, but we
 *     make the intent explicit).
 *  3. Remove a single trailing slash from the pathname when the pathname
 *     is exactly "/" and there is no meaningful path — this collapses
 *     "https://example.com/" and "https://example.com" to the same key.
 *  4. Preserve query strings and fragments as-is (they may be significant
 *     for cache identity).
 *
 * Returns `null` if the URL is not parseable.
 */
function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);

    // Lowercase the hostname explicitly (URL constructor lowercases it,
    // but we document the guarantee here).
    url.hostname = url.hostname.toLowerCase();

    // Remove a bare trailing slash so "https://x.com/" === "https://x.com".
    // Only strip when the path is exactly "/" and there is no query/hash,
    // otherwise "/api/" and "/api" are intentionally different keys.
    let href = url.href;
    if (
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      href.endsWith("/")
    ) {
      href = href.slice(0, -1);
    }

    return href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// WebCache
// ---------------------------------------------------------------------------

/**
 * In-memory URL content cache with TTL expiration and size-bounded LRU eviction.
 *
 * Thread-safety note: This class is designed for single-threaded JS runtimes.
 * No internal locking is provided.
 */
export class WebCache {
  private readonly defaultTtlMs: number;
  private readonly maxCacheSizeBytes: number;

  /**
   * The backing store. We use a `Map` because it preserves insertion order,
   * which gives us a natural oldest-first iteration for eviction.
   */
  private readonly store: Map<string, CacheEntry> = new Map();

  /** Running total of `sizeBytes` across all entries in the store. */
  private currentSizeBytes: number = 0;

  /** Number of `get` / `has` calls that found a valid (non-expired) entry. */
  private hitCount: number = 0;

  /** Number of `get` / `has` calls that did not find a valid entry. */
  private missCount: number = 0;

  constructor(options?: WebCacheOptions) {
    this.defaultTtlMs = options?.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.maxCacheSizeBytes =
      options?.maxCacheSizeBytes ?? DEFAULT_MAX_CACHE_SIZE_BYTES;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Retrieve a cached entry for the given URL.
   *
   * Returns `null` (and records a miss) when:
   *  - The URL has never been cached.
   *  - The cached entry has expired according to its TTL.
   *
   * Expired entries are lazily removed on access.
   */
  get(url: string): CacheEntry | null {
    const key = normalizeUrl(url);
    if (key === null) {
      this.missCount++;
      return null;
    }

    const entry = this.store.get(key);
    if (entry === undefined) {
      this.missCount++;
      return null;
    }

    if (this.isExpired(entry)) {
      // Lazy eviction of expired entry.
      this.removeEntry(key, entry);
      this.missCount++;
      return null;
    }

    this.hitCount++;
    return entry;
  }

  /**
   * Store a URL response in the cache.
   *
   * If the content size alone exceeds `maxCacheSizeBytes`, the entry is
   * still stored (after evicting everything else) so that oversized single
   * responses do not silently vanish — callers can observe them via `get`
   * until they expire.
   *
   * @param url     The URL to cache.
   * @param content The response body.
   * @param meta    Optional metadata for the cached entry.
   * @returns The newly created CacheEntry.
   */
  put(
    url: string,
    content: string,
    meta: {
      contentType?: string;
      statusCode?: number;
      ttlMs?: number;
    } = {},
  ): CacheEntry {
    const key = normalizeUrl(url);
    if (key === null) {
      // If the URL is fundamentally unparseable, we still create an entry
      // keyed by the raw string so the caller gets a valid return value.
      // This mirrors lenient cache semantics — garbage in, garbage stored.
      return this.insertEntry(url, url, content, meta);
    }

    // If the key already exists, remove the old entry first so that
    // size accounting stays accurate and insertion order is refreshed.
    const existing = this.store.get(key);
    if (existing !== undefined) {
      this.removeEntry(key, existing);
    }

    return this.insertEntry(key, key, content, meta);
  }

  /**
   * Check whether a non-expired cache entry exists for the given URL.
   *
   * This method updates hit/miss counters identically to `get`.
   */
  has(url: string): boolean {
    const key = normalizeUrl(url);
    if (key === null) {
      this.missCount++;
      return false;
    }

    const entry = this.store.get(key);
    if (entry === undefined) {
      this.missCount++;
      return false;
    }

    if (this.isExpired(entry)) {
      this.removeEntry(key, entry);
      this.missCount++;
      return false;
    }

    this.hitCount++;
    return true;
  }

  /**
   * Remove a specific URL from the cache.
   *
   * @returns `true` if an entry was found and removed, `false` otherwise.
   */
  invalidate(url: string): boolean {
    const key = normalizeUrl(url);
    if (key === null) {
      return false;
    }

    const entry = this.store.get(key);
    if (entry === undefined) {
      return false;
    }

    this.removeEntry(key, entry);
    return true;
  }

  /**
   * Remove all entries from the cache and reset counters.
   */
  clear(): void {
    this.store.clear();
    this.currentSizeBytes = 0;
    this.hitCount = 0;
    this.missCount = 0;
  }

  /**
   * Return a snapshot of cache statistics.
   */
  stats(): {
    entries: number;
    totalSizeBytes: number;
    maxSizeBytes: number;
    hitCount: number;
    missCount: number;
  } {
    return {
      entries: this.store.size,
      totalSizeBytes: this.currentSizeBytes,
      maxSizeBytes: this.maxCacheSizeBytes,
      hitCount: this.hitCount,
      missCount: this.missCount,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Determine whether an entry has exceeded its TTL.
   */
  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.cachedAt >= entry.ttlMs;
  }

  /**
   * Remove a single entry from the store and update size accounting.
   */
  private removeEntry(key: string, entry: CacheEntry): void {
    this.store.delete(key);
    this.currentSizeBytes -= entry.sizeBytes;

    // Guard against floating-point drift or double-removal.
    if (this.currentSizeBytes < 0) {
      this.currentSizeBytes = 0;
    }
  }

  /**
   * Evict oldest entries (by insertion order) until `requiredBytes` can fit
   * within the `maxCacheSizeBytes` budget.
   *
   * Expired entries encountered during eviction are removed regardless of
   * whether their removal is strictly necessary to reclaim space.
   */
  private evict(requiredBytes: number): void {
    const target = this.maxCacheSizeBytes - requiredBytes;

    // Fast path: nothing to evict.
    if (this.currentSizeBytes <= target) {
      return;
    }

    // Map iteration order is insertion order — oldest entries come first.
    for (const [key, entry] of this.store) {
      if (this.currentSizeBytes <= target) {
        break;
      }
      this.removeEntry(key, entry);
    }
  }

  /**
   * Create a CacheEntry, run eviction if necessary, and insert it.
   */
  private insertEntry(
    key: string,
    url: string,
    content: string,
    meta: {
      contentType?: string;
      statusCode?: number;
      ttlMs?: number;
    },
  ): CacheEntry {
    const sizeBytes = approximateByteSize(content);

    const entry: CacheEntry = {
      url,
      content,
      contentType: meta.contentType ?? "text/plain",
      statusCode: meta.statusCode ?? 200,
      cachedAt: Date.now(),
      ttlMs: meta.ttlMs ?? this.defaultTtlMs,
      sizeBytes,
    };

    // Evict oldest entries to make room for the new one.
    this.evict(sizeBytes);

    this.store.set(key, entry);
    this.currentSizeBytes += sizeBytes;

    return entry;
  }
}
