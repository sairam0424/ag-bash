/**
 * Sliding window rate limiter for MCP tool calls.
 *
 * Tracks request timestamps within a configurable window and rejects
 * calls that exceed the maximum allowed requests per window.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests = 60, windowMs = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /** Returns true if the request is allowed, false if rate-limited. */
  allow(): boolean {
    const now = Date.now();
    // Remove timestamps outside the window
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxRequests) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }

  /** Reset the rate limiter state. */
  reset(): void {
    this.timestamps = [];
  }

  /** Get the number of requests remaining in the current window. */
  remaining(): number {
    const now = Date.now();
    const active = this.timestamps.filter((t) => now - t < this.windowMs);
    return Math.max(0, this.maxRequests - active.length);
  }
}
