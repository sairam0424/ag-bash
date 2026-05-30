/**
 * SSRF hardening tests for v6.0.0 (TASK E1):
 *  - denyPrivateRanges defaults ON (no NODE_ENV dependency)
 *  - hostnames resolving to private IPs are blocked
 *  - DNS-rebinding (public-then-private) is blocked: the validated address is
 *    pinned so the connection cannot be rebound to a private IP
 *  - cloud metadata endpoints are blocked by NAME and by IP
 *
 * These exercise the `_dnsResolve` seam so they are fully deterministic and
 * never touch the real network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMetadataEndpoint } from "../allow-list.js";
import { createSecureFetch } from "../fetch.js";
import type { DnsLookupResult } from "../types.js";
import { NetworkAccessDeniedError } from "../types.js";

const PUBLIC_IP = "93.184.216.34";

/** A resolver returning fixed addresses. */
function fixedResolver(
  addresses: DnsLookupResult[],
): (hostname: string) => Promise<DnsLookupResult[]> {
  return () => Promise.resolve(addresses);
}

/**
 * A rebinding resolver: returns a PUBLIC address on the first call (the
 * validation lookup) and a PRIVATE address on every subsequent call (what an
 * independent re-resolution at connect time would see). The pin must defeat
 * this by connecting only to the address validated on the first call.
 */
function rebindingResolver(): {
  resolve: (hostname: string) => Promise<DnsLookupResult[]>;
  callCount: () => number;
} {
  let calls = 0;
  return {
    resolve: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve([{ address: PUBLIC_IP, family: 4 }]);
      }
      return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
    },
    callCount: () => calls,
  };
}

describe("SSRF pin + default-on (v6.0.0)", () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockFetch = vi.fn<typeof fetch>(
      async () => new Response("ok", { status: 200 }),
    );
    global.fetch = mockFetch as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("(a) denyPrivateRanges defaults ON regardless of NODE_ENV", () => {
    it("blocks a hostname resolving to a private IP without setting denyPrivateRanges", async () => {
      // denyPrivateRanges is intentionally NOT set: the v6.0.0 default must be
      // ON regardless of NODE_ENV. Previously this was off unless
      // NODE_ENV === "production".
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: fixedResolver([{ address: "10.0.0.5", family: 4 }]),
      });
      await expect(
        secureFetch("https://internal.example.com/x"),
      ).rejects.toThrow(NetworkAccessDeniedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("blocks an IP literal in the private range by default", async () => {
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
      });
      await expect(secureFetch("https://192.168.1.1/x")).rejects.toThrow(
        /private\/loopback IP address blocked/,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("can be explicitly opted out with denyPrivateRanges:false", async () => {
      const resolver = vi.fn(
        fixedResolver([{ address: "10.0.0.5", family: 4 }]),
      );
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        denyPrivateRanges: false,
        _dnsResolve: resolver,
      });
      const result = await secureFetch("https://internal.example.com/x");
      expect(result.status).toBe(200);
      // opt-out skips DNS resolution entirely
      expect(resolver).not.toHaveBeenCalled();
    });
  });

  describe("(b) hostname resolving to a private IP is blocked", () => {
    it("blocks domain → 127.0.0.1", async () => {
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: fixedResolver([{ address: "127.0.0.1", family: 4 }]),
      });
      await expect(secureFetch("https://rebind.example.com/x")).rejects.toThrow(
        /resolves to private\/loopback/,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("blocks when ANY of multiple resolved addresses is private", async () => {
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: fixedResolver([
          { address: PUBLIC_IP, family: 4 },
          { address: "10.1.2.3", family: 4 },
        ]),
      });
      await expect(secureFetch("https://multi.example.com/x")).rejects.toThrow(
        /resolves to private\/loopback/,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("allows a domain resolving only to public IPs", async () => {
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: fixedResolver([{ address: PUBLIC_IP, family: 4 }]),
      });
      const result = await secureFetch("https://api.example.com/x");
      expect(result.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("(c) DNS rebinding: public-then-private is blocked by the pin", () => {
    it("resolves DNS exactly once for the validation and pins it", async () => {
      const { resolve, callCount } = rebindingResolver();
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: resolve,
      });

      // The first (validation) lookup returns a public IP, so the request is
      // allowed and the connection is pinned to that public IP. The fetch
      // succeeds against the mock; crucially DNS is resolved ONCE (no second
      // independent re-resolution that could surface the private address).
      const result = await secureFetch("https://rebind.example.com/x");
      expect(result.status).toBe(200);
      expect(callCount()).toBe(1);
    });

    it("blocks when the single validation lookup already returns private", async () => {
      // If the very first (and only) resolution is private, it is rejected —
      // there is no window where a public answer could be substituted.
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: fixedResolver([{ address: "127.0.0.1", family: 4 }]),
      });
      await expect(secureFetch("https://rebind.example.com/x")).rejects.toThrow(
        NetworkAccessDeniedError,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("re-validates and re-pins on each redirect hop (rebind on redirect blocked)", async () => {
      // Initial host resolves public; redirect target resolves private.
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: (hostname: string) =>
          hostname === "evil.example.com"
            ? Promise.resolve([{ address: "169.254.169.254", family: 4 }])
            : Promise.resolve([{ address: PUBLIC_IP, family: 4 }]),
      });

      mockFetch.mockImplementation(async (url: string | URL | Request) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u === "https://start.example.com/go") {
          return new Response("", {
            status: 302,
            headers: { location: "https://evil.example.com/data" },
          });
        }
        return new Response("ok", { status: 200 });
      });

      await expect(secureFetch("https://start.example.com/go")).rejects.toThrow(
        /Redirect target not in allow-list/,
      );
    });
  });

  describe("(d) cloud metadata endpoints are blocked", () => {
    it("blocks 169.254.169.254 by IP literal", async () => {
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
      });
      await expect(
        secureFetch("http://169.254.169.254/latest/meta-data/"),
      ).rejects.toThrow(NetworkAccessDeniedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("blocks metadata.google.internal by name (even if DNS lies)", async () => {
      // A rebinding attacker could point this name at a public IP; the name
      // block fires before DNS so it is unreachable regardless.
      const resolver = vi.fn(
        fixedResolver([{ address: PUBLIC_IP, family: 4 }]),
      );
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: resolver,
      });
      await expect(
        secureFetch("http://metadata.google.internal/computeMetadata/v1/"),
      ).rejects.toThrow(/cloud metadata endpoint blocked/);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(resolver).not.toHaveBeenCalled();
    });

    it("blocks a benign-looking domain that RESOLVES to the metadata IP", async () => {
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: fixedResolver([{ address: "169.254.169.254", family: 4 }]),
      });
      await expect(
        secureFetch("http://imds.attacker.example/x"),
      ).rejects.toThrow(NetworkAccessDeniedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("blocks the AWS IPv6 metadata address fd00:ec2::254", async () => {
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
      });
      await expect(
        secureFetch("http://[fd00:ec2::254]/latest/"),
      ).rejects.toThrow(NetworkAccessDeniedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("isMetadataEndpoint unit coverage", () => {
    it("matches metadata IPs and hostnames, rejects others", () => {
      expect(isMetadataEndpoint("169.254.169.254")).toBe(true);
      expect(isMetadataEndpoint("fd00:ec2::254")).toBe(true);
      expect(isMetadataEndpoint("[fd00:ec2::254]")).toBe(true);
      expect(isMetadataEndpoint("metadata.google.internal")).toBe(true);
      expect(isMetadataEndpoint("METADATA.GOOGLE.INTERNAL")).toBe(true);
      expect(isMetadataEndpoint("metadata")).toBe(true);
      // Octal/decimal encodings of 169.254.169.254 canonicalize and match.
      expect(isMetadataEndpoint("0251.0376.0251.0376")).toBe(true);
      expect(isMetadataEndpoint("example.com")).toBe(false);
      expect(isMetadataEndpoint("93.184.216.34")).toBe(false);
      expect(isMetadataEndpoint("169.254.169.255")).toBe(false);
    });
  });
});
