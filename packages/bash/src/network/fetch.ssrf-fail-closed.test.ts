/**
 * Fail-closed regression tests for the "resolve once, validate all, pin the
 * result" SSRF gate in {@link createSecureFetch} (defects U51 + U52).
 *
 * U51: a DNS resolution that does NOT complete (timeout) previously returned
 * "no pin" from the validation gate, which ALSO meant no address was ever
 * range-checked — and undici then resolved the hostname independently, with no
 * knowledge of the blocklist. An attacker able to slow the first resolution got
 * an unvalidated connection. Resolution that did not complete must now REFUSE.
 *
 * U52: when the connection-pinning primitives are unavailable the request still
 * proceeds (the addresses WERE validated; only the rebinding pin is missing) —
 * but that must be observable rather than silent.
 *
 * Every test drives the deterministic seams (`_dnsResolve`,
 * `_setPinningAgentFactory`) or the hoisted `node:dns` stub below. No real DNS
 * query and no real network request is ever issued.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * State for the `node:dns` stub installed by the bounded-lookup test. Its
 * `lookup` NEVER invokes the callback — the shape of an attacker-slowed (or
 * blocking) host resolver — so fetch.ts's own bound is forced to fire and no
 * real DNS query is ever issued.
 *
 * Installed per-test with `vi.doMock` + `vi.resetModules()` rather than a
 * file-level `vi.mock`: the repo's default lane runs with `isolate: false`
 * (packages/bash/vitest.config.ts), where a file-level module mock does not
 * bind if another test file in the same worker already imported fetch.ts.
 */
const dnsState = { hostnames: [] as readonly string[] };

import {
  _setPinningAgentFactory,
  clearUnpinnedRequests,
  createSecureFetch,
  DnsResolutionUnverifiedError,
  getUnpinnedRequests,
} from "./fetch.js";
import type { DnsLookupResult } from "./types.js";
import { NetworkAccessDeniedError, RedirectNotAllowedError } from "./types.js";

const PUBLIC_IP = "93.184.216.34";

type PinnedLookup = (
  hostname: string,
  options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: { address: string; family: number }[] | string,
    family?: number,
  ) => void,
) => void;

/** Captures the `connect.lookup` a built dispatcher was constructed with. */
const agentState = vi.hoisted(() => ({
  lookup: undefined as PinnedLookup | undefined,
}));

/**
 * Stand-in for undici's `Agent`. Lets the pinned branch be exercised even
 * though `undici` is not resolvable in this repo (see the report: the real
 * dispatcher never engages here, which is exactly why U52's fallback must be
 * observable).
 */
class FakeAgent {
  constructor(opts: { connect: { lookup: PinnedLookup } }) {
    agentState.lookup = opts.connect.lookup;
  }
}

function fixedResolver(
  addresses: DnsLookupResult[],
): (hostname: string) => Promise<DnsLookupResult[]> {
  return () => Promise.resolve(addresses);
}

function rejectingResolver(
  code: string,
  message: string,
): (hostname: string) => Promise<DnsLookupResult[]> {
  return () => {
    const err = new Error(message);
    (err as NodeJS.ErrnoException).code = code;
    return Promise.reject(err);
  };
}

describe("secureFetch SSRF fail-closed (U51/U52)", () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockFetch = vi.fn<typeof fetch>(
      async () => new Response("ok", { status: 200 }),
    );
    global.fetch = mockFetch as typeof fetch;
    clearUnpinnedRequests();
    dnsState.hostnames = [];
    agentState.lookup = undefined;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // Restore lazy detection of the pinning primitives.
    _setPinningAgentFactory(undefined);
    clearUnpinnedRequests();
    vi.restoreAllMocks();
  });

  describe("U51 — a resolution that did not complete fails closed", () => {
    it("refuses when the resolver reports a timeout", async () => {
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: rejectingResolver("ETIMEDOUT", "queryA ETIMEDOUT"),
      });

      await expect(
        secureFetch("https://slow-resolver.example.com/x"),
      ).rejects.toThrow(DnsResolutionUnverifiedError);
      // The refusal must remain a NetworkAccessDeniedError so every existing
      // caller (curl's exit-code mapping, host error handling) still sees it.
      await expect(
        secureFetch("https://slow-resolver.example.com/x"),
      ).rejects.toThrow(NetworkAccessDeniedError);
      expect(mockFetch).not.toHaveBeenCalled();
      // A refused request is not an "unpinned fallback" — nothing proceeded.
      expect(getUnpinnedRequests()).toEqual([]);
    });

    it("refuses when fetch.ts's own bounded lookup times out", async () => {
      // The attacker path: no `_dnsResolve`, so this drives the real
      // dnsLookupAll() against a node:dns whose lookup never answers. The
      // internal bound is what fires.
      dnsState.hostnames = [];
      vi.resetModules();
      vi.doMock("node:dns", () => ({
        lookup: (hostname: string) => {
          dnsState.hostnames = [...dnsState.hostnames, hostname];
          // Deliberately never calls back.
        },
      }));

      try {
        const freshModule = await import("./fetch.js");
        const secureFetch = freshModule.createSecureFetch({
          dangerouslyAllowFullInternetAccess: true,
          timeoutMs: 50,
        });

        await expect(
          secureFetch("https://blocking-resolver.example.com/x"),
        ).rejects.toThrow(freshModule.DnsResolutionUnverifiedError);
        // Proves the stub — not the host resolver — was consulted.
        expect(dnsState.hostnames).toContain("blocking-resolver.example.com");
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        vi.doUnmock("node:dns");
        vi.resetModules();
      }
    });

    it("refuses when the resolver completes with zero addresses", async () => {
      // Nothing was validated, so there is nothing to pin and undici would
      // resolve the name itself — same fail-open shape as the timeout.
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: fixedResolver([]),
      });

      await expect(
        secureFetch("https://empty-answer.example.com/x"),
      ).rejects.toThrow(DnsResolutionUnverifiedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does not leak resolver error text or resolved addresses in the refusal", async () => {
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: rejectingResolver(
          "ETIMEDOUT",
          "getaddrinfo ETIMEDOUT via 10.1.2.3 (/Users/secret/resolv.conf)",
        ),
      });

      const error = await secureFetch(
        "https://slow-resolver.example.com/x",
      ).then(
        () => undefined,
        (e: unknown) => e as Error,
      );

      expect(error).toBeInstanceOf(DnsResolutionUnverifiedError);
      expect(error?.message).not.toContain("getaddrinfo");
      expect(error?.message).not.toContain("10.1.2.3");
      expect(error?.message).not.toContain("resolv.conf");
      expect(error?.message).not.toContain("/Users/");
    });

    it("refuses when the resolver fails with an error carrying no code", async () => {
      // The default branch. An error with no `code` is the least-known failure
      // shape, so it is the one most likely to be mishandled — and it still
      // means nothing was range-checked.
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: () => Promise.reject(new Error("resolver exploded")),
      });

      await expect(
        secureFetch("https://broken-resolver.example.com/x"),
      ).rejects.toThrow(DnsResolutionUnverifiedError);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(getUnpinnedRequests()).toEqual([]);
    });

    it("refuses a redirect hop whose resolution times out", async () => {
      mockFetch.mockImplementation(async (url: string | URL | Request) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u === "https://start.example.com/go") {
          return new Response("", {
            status: 302,
            headers: { location: "https://slow.example.com/data" },
          });
        }
        return new Response("ok", { status: 200 });
      });

      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: (hostname: string) => {
          if (hostname === "slow.example.com") {
            const err = new Error("queryA ETIMEDOUT");
            (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
            return Promise.reject(err);
          }
          return Promise.resolve([{ address: PUBLIC_IP, family: 4 }]);
        },
      });

      await expect(secureFetch("https://start.example.com/go")).rejects.toThrow(
        RedirectNotAllowedError,
      );
      // Only the first hop was ever dispatched.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("U52 — the unpinned fallback is observable", () => {
    it("pins the connection and records nothing when the primitives are available", async () => {
      _setPinningAgentFactory(FakeAgent);
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: fixedResolver([{ address: PUBLIC_IP, family: 4 }]),
      });

      const result = await secureFetch("https://api.example.com/x");
      expect(result.status).toBe(200);

      const init = mockFetch.mock.calls[0]?.[1] as
        | (RequestInit & { dispatcher?: unknown })
        | undefined;
      expect(init?.dispatcher).toBeInstanceOf(FakeAgent);

      // The pinned lookup must hand back ONLY the validated address, whatever
      // the hostname resolves to at connect time.
      const captured = agentState.lookup;
      expect(captured).toBeTypeOf("function");
      const pinned = await new Promise<
        { address: string; family: number }[] | string
      >((resolve, reject) => {
        captured?.("api.example.com", {}, (err, addresses) => {
          if (err) reject(err);
          else resolve(addresses);
        });
      });
      expect(pinned).toEqual([{ address: PUBLIC_IP, family: 4 }]);

      expect(getUnpinnedRequests()).toEqual([]);
    });

    it("records the fallback when the pinning primitives are unavailable", async () => {
      _setPinningAgentFactory(null);
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: fixedResolver([{ address: PUBLIC_IP, family: 4 }]),
      });

      const result = await secureFetch("https://api.example.com/x");
      expect(result.status).toBe(200);

      const init = mockFetch.mock.calls[0]?.[1] as
        | (RequestInit & { dispatcher?: unknown })
        | undefined;
      expect(init?.dispatcher).toBeUndefined();

      expect(getUnpinnedRequests()).toEqual([
        { hostname: "api.example.com", reason: "pinning-unavailable" },
      ]);
    });

    it("reports the fallback loudly once, but records every request", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      _setPinningAgentFactory(null);
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: fixedResolver([{ address: PUBLIC_IP, family: 4 }]),
      });

      await secureFetch("https://api.example.com/x");
      await secureFetch("https://cdn.example.com/y");

      expect(getUnpinnedRequests()).toEqual([
        { hostname: "api.example.com", reason: "pinning-unavailable" },
        { hostname: "cdn.example.com", reason: "pinning-unavailable" },
      ]);
      // Loud, but not once per request — a per-request warning would be noise
      // an operator learns to ignore.
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("caps retained records and keeps the newest", async () => {
      // The record buffer is fed by every unpinned request, so an unbounded
      // list would be a memory-growth vector on a long-running host. Retention
      // must be bounded AND must drop the OLDEST, or the cap would hide the
      // most recent (most relevant) evidence.
      _setPinningAgentFactory(null);
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: fixedResolver([{ address: PUBLIC_IP, family: 4 }]),
      });

      const total = 55;
      for (let i = 0; i < total; i++) {
        await secureFetch(`https://h${i}.example.com/x`);
      }

      const records = getUnpinnedRequests();
      expect(records).toHaveLength(50);
      // Oldest five (h0..h4) evicted; the newest is still present.
      expect(records[0]).toEqual({
        hostname: "h5.example.com",
        reason: "pinning-unavailable",
      });
      expect(records[records.length - 1]).toEqual({
        hostname: `h${total - 1}.example.com`,
        reason: "pinning-unavailable",
      });
    });

    it("records the fallback for a host the resolver says does not exist", async () => {
      // ENOTFOUND keeps its existing pass-through behaviour (an existing test
      // in allow-list/dns-rebinding.test.ts depends on it), but it is another
      // unpinned request and must no longer be silent.
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: rejectingResolver("ENOTFOUND", "getaddrinfo ENOTFOUND"),
      });

      const result = await secureFetch("https://ghost.example.com/x");
      expect(result.status).toBe(200);
      expect(getUnpinnedRequests()).toEqual([
        { hostname: "ghost.example.com", reason: "unresolved-host" },
      ]);
    });
  });
});
