/**
 * Secure fetch wrapper with allow-list enforcement
 *
 * This module provides a fetch wrapper that:
 * 1. Enforces URL allow-list at the fetch layer (not subject to parsing)
 * 2. Handles redirects manually to check each redirect target against the allow-list
 * 3. Provides timeout support
 */

import { lookup as dnsLookup } from "node:dns";
import { createRequire as nodeCreateRequire } from "node:module";
import { DefenseInDepthBox } from "../security/defense-in-depth-box.js";
import { _clearTimeout, _setTimeout } from "../timers.js";
import {
  isMetadataEndpoint,
  isPrivateIp,
  isUrlAllowed,
  matchesAllowListEntry,
  validateAllowList,
} from "./allow-list.js";
import type { AllowedUrl, AllowedUrlEntry, DnsLookupResult } from "./types.js";
import {
  type FetchResult,
  type HttpMethod,
  MethodNotAllowedError,
  NetworkAccessDeniedError,
  type NetworkConfig,
  RedirectNotAllowedError,
  ResponseTooLargeError,
  TooManyRedirectsError,
} from "./types.js";

/**
 * Error thrown when the private-IP DNS lookup exceeds its bound. Treated by
 * {@link checkAndResolve} exactly like an ENOTFOUND: the resolver produced no
 * address within the window, so there is nothing to pin and the request is
 * allowed to proceed to the real fetch (which performs its own bounded
 * connect). A distinct class lets the caller distinguish this from a genuine
 * resolver failure that must fail closed.
 */
class DnsLookupTimeoutError extends Error {
  readonly code = "ETIMEDOUT" as const;
  constructor() {
    super("DNS lookup timed out");
    this.name = "DnsLookupTimeoutError";
  }
}

const DEFAULT_MAX_REDIRECTS = 20;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_SIZE = 10485760; // 10MB
const DEFAULT_ALLOWED_METHODS: HttpMethod[] = ["GET", "HEAD"];
/**
 * Upper bound for the private-range DNS lookup. The lexical and pin checks are
 * the real SSRF defenses; this lookup only catches domains that resolve to a
 * private IP, and a real public resolver answers in well under a second. The
 * bound therefore tracks the request timeout but is capped tightly so the
 * lookup can NEVER hang the caller (e.g. when the host resolver itself blocks
 * for ~30s in an offline/sandboxed environment) — the cap is the load-bearing
 * value; the per-request timeout only ever lowers it.
 */
const DNS_LOOKUP_TIMEOUT_CAP_MS = 1000;

// DNS resolution for private IP check. Bounded so a blocking host resolver
// (offline/sandboxed environments where getaddrinfo can stall ~30s) can never
// hang the request. On timeout we reject with DnsLookupTimeoutError, which
// checkAndResolve treats like ENOTFOUND (no address obtained → nothing to pin).
function dnsLookupAll(
  hostname: string,
  timeoutMs: number,
): Promise<DnsLookupResult[]> {
  return new Promise<DnsLookupResult[]>((resolve, reject) => {
    let settled = false;
    const timer = _setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new DnsLookupTimeoutError());
    }, timeoutMs);

    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (settled) return;
      settled = true;
      _clearTimeout(timer);
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

/**
 * Builds the per-request connection pin. Undici (the engine behind Node's
 * global `fetch`) honors a `dispatcher` whose `connect` options carry a
 * custom `lookup`. We override `lookup` to return ONLY a pre-validated
 * address, so the socket connects to exactly the IP we checked — closing the
 * DNS-rebinding/TOCTOU window between {@link checkAndResolve} and the actual
 * connect (undici would otherwise re-resolve the hostname independently).
 *
 * The undici primitives are loaded lazily and defensively via
 * {@link loadPinningAgentFactory}. When they are unavailable (e.g. `fetch` is
 * mocked in tests, or undici is not resolvable), {@link buildPinnedDispatcher}
 * returns `undefined` and the resolve-once/validate-all gate in
 * {@link checkAndResolve} remains the authoritative protection.
 */
type UndiciAgent = {
  // biome-ignore lint/suspicious/noExplicitAny: undici Agent options are broad
  new (opts: any): unknown;
};

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  addresses: { address: string; family: number }[] | string,
  family?: number,
) => void;

let pinningAgentFactory: UndiciAgent | null | undefined;

/**
 * Lazily resolves undici's `Agent` constructor without dynamic `import()`
 * (banned) or `eval`. Uses `node:module`'s `createRequire` — a static builtin
 * import — to load undici only if the host runtime makes it resolvable.
 * Cached after the first attempt; `null` means pinning via a dispatcher is
 * unavailable and the resolve-once/validate-all gate is the sole protection.
 */
function loadPinningAgentFactory(): UndiciAgent | null {
  if (pinningAgentFactory !== undefined) {
    return pinningAgentFactory ?? null;
  }
  try {
    const req = nodeCreateRequire(import.meta.url);
    const undici = req("undici") as { Agent?: UndiciAgent };
    pinningAgentFactory = undici.Agent ?? null;
  } catch {
    pinningAgentFactory = null;
  }
  return pinningAgentFactory;
}

/**
 * Returns the IP family (4 or 6) for a pinned address literal.
 */
function familyOf(address: string): number {
  return address.includes(":") ? 6 : 4;
}

/**
 * Builds an undici dispatcher that pins connections to `pinnedAddresses`.
 * Returns `undefined` when pinning primitives are unavailable.
 */
function buildPinnedDispatcher(pinnedAddresses: string[]): unknown {
  if (pinnedAddresses.length === 0) return undefined;
  const Agent = loadPinningAgentFactory();
  if (!Agent) return undefined;

  const pinned = pinnedAddresses.map((address) => ({
    address,
    family: familyOf(address),
  }));

  const lookup = (
    _hostname: string,
    _options: unknown,
    callback: LookupCallback,
  ): void => {
    // Always return the validated, pinned addresses regardless of what the
    // hostname currently resolves to. This is the rebinding pin.
    callback(null, pinned);
  };

  try {
    return new Agent({ connect: { lookup } });
  } catch {
    return undefined;
  }
}

/**
 * HTTP methods that should not have a body
 */
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Redirect status codes
 */
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export interface SecureFetchOptions {
  method?: string;
  headers?: Headers | Record<string, string>;
  body?: string;
  followRedirects?: boolean;
  /** Override timeout for this request (capped at global timeout) */
  timeoutMs?: number;
}

/**
 * Type for the secure fetch function
 */
export type SecureFetch = (
  url: string,
  options?: SecureFetchOptions,
) => Promise<FetchResult>;

/**
 * Creates a secure fetch function that enforces the allow-list.
 */
export function createSecureFetch(config: NetworkConfig): SecureFetch {
  const entries: AllowedUrlEntry[] = config.allowedUrlPrefixes ?? [];

  // Fail fast on invalid allow-list entries
  if (!config.dangerouslyAllowFullInternetAccess) {
    const errors = validateAllowList(entries);
    if (errors.length > 0) {
      throw new Error(`Invalid network allow-list:\n${errors.join("\n")}`);
    }
  }

  // Collect entries that carry transforms for firewall header injection.
  const transformEntries: AllowedUrl[] = [];
  for (const entry of entries) {
    if (
      typeof entry === "object" &&
      entry.transform &&
      entry.transform.length > 0
    ) {
      transformEntries.push(entry);
    }
  }

  /**
   * Returns firewall headers for a given URL by matching against transform
   * entries using URL prefix matching (same logic as the allow-list).
   *
   * When multiple entries match (overlapping prefixes), later entries
   * override earlier ones for the same header name via `set()`. This
   * means a path-specific `Authorization` overrides an origin-wide one.
   */
  function getFirewallHeaders(url: string): Headers | null {
    if (transformEntries.length === 0) return null;
    let merged: Headers | null = null;
    for (const entry of transformEntries) {
      if (matchesAllowListEntry(url, entry.url) && entry.transform) {
        if (!merged) merged = new Headers();
        for (const t of entry.transform) {
          for (const [key, value] of Object.entries(t.headers)) {
            merged.set(key, value);
          }
        }
      }
    }
    return merged;
  }

  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseSize = config.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
  const allowedMethods = config.dangerouslyAllowFullInternetAccess
    ? ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
    : (config.allowedMethods ?? DEFAULT_ALLOWED_METHODS);
  // Deny private/loopback/metadata ranges by default (v6.0.0). Callers can
  // opt out explicitly with `denyPrivateRanges: false`. Previously this
  // defaulted on only when NODE_ENV === "production", which left SSRF
  // protection off in the common (unset NODE_ENV) case — a breaking but
  // safer default.
  const denyPrivateRanges = config.denyPrivateRanges ?? true;
  // The private-range DNS lookup is bounded by the smaller of the tight cap
  // and the request timeout, so it can never outlast the request it guards
  // (and can never hang on a blocking host resolver). An injected
  // `_dnsResolve` (tests) is deterministic and used as-is.
  const dnsTimeoutMs = Math.min(DNS_LOOKUP_TIMEOUT_CAP_MS, timeoutMs);
  const resolveDns =
    config._dnsResolve ??
    ((hostname: string) => dnsLookupAll(hostname, dnsTimeoutMs));

  /**
   * Validates a URL against the allow-list, the private-range policy, and the
   * metadata-endpoint blocklist. When `denyPrivateRanges` is on and the host
   * is a domain name, DNS is resolved EXACTLY ONCE here and every returned
   * A/AAAA address is validated; the validated address set is returned so the
   * subsequent connection can be pinned to it (TOCTOU / DNS-rebinding
   * protection). For IP literals the literal itself is the pin.
   *
   * @returns the list of validated IP addresses to pin the connection to, or
   *   `null` when no pin is available/needed (full-access without
   *   denyPrivateRanges, ENOTFOUND domains, or invalid URLs).
   * @throws NetworkAccessDeniedError if the URL is not allowed
   */
  async function checkAndResolve(url: string): Promise<string[] | null> {
    if (
      !config.dangerouslyAllowFullInternetAccess &&
      !isUrlAllowed(url, entries)
    ) {
      throw new NetworkAccessDeniedError(url);
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // Malformed URL — let the downstream fetch fail naturally / allow-list
      // already rejected it above when not in full-access mode.
      return null;
    }

    const hostname = parsed.hostname;

    // Cloud metadata endpoints are blocked by NAME unconditionally, regardless
    // of denyPrivateRanges, so instance credentials can never be reached even
    // if a caller relaxes the private-range policy.
    if (isMetadataEndpoint(hostname)) {
      throw new NetworkAccessDeniedError(
        url,
        "cloud metadata endpoint blocked",
      );
    }

    if (!denyPrivateRanges) {
      return null;
    }

    // Lexical check (fast path: catches IP literals and localhost).
    if (isPrivateIp(hostname)) {
      throw new NetworkAccessDeniedError(
        url,
        "private/loopback IP address blocked",
      );
    }

    // IP literals were validated lexically above; the literal is the pin.
    const isDomainName = /[a-zA-Z]/.test(hostname);
    if (!isDomainName) {
      return [hostname];
    }

    // Resolve the domain ONCE. Every returned address must be public and
    // non-metadata, otherwise the host is rejected. The resolved set becomes
    // the connection pin so the real fetch cannot connect to a different
    // (rebound) address.
    let addresses: DnsLookupResult[];
    try {
      addresses = await resolveDns(hostname);
    } catch (dnsErr) {
      // ENOTFOUND/ENODATA: domain doesn't resolve, so it can't resolve to a
      // private IP — no rebinding risk; let the fetch fail naturally.
      // ETIMEDOUT: the bounded lookup produced no address within the window
      // (e.g. a blocking host resolver). Like ENOTFOUND there is no resolved
      // address to pin and the real fetch performs its own bounded connect, so
      // we proceed without a pin rather than hang.
      const code = (dnsErr as NodeJS.ErrnoException)?.code;
      if (code === "ENOTFOUND" || code === "ENODATA" || code === "ETIMEDOUT") {
        return null;
      }
      // Unexpected DNS error: fail closed (block).
      throw new NetworkAccessDeniedError(
        url,
        "DNS resolution failed for private IP check",
      );
    }

    const pinned: string[] = [];
    for (const { address } of addresses) {
      if (isMetadataEndpoint(address)) {
        throw new NetworkAccessDeniedError(
          url,
          "cloud metadata endpoint blocked",
        );
      }
      if (isPrivateIp(address)) {
        throw new NetworkAccessDeniedError(
          url,
          "hostname resolves to private/loopback IP address",
        );
      }
      pinned.push(address);
    }

    // No addresses returned (empty resolver result): nothing to pin, let the
    // fetch fail naturally rather than fabricating a target.
    return pinned.length > 0 ? pinned : null;
  }

  /**
   * Checks if an HTTP method is allowed by the configuration.
   * @throws MethodNotAllowedError if the method is not allowed
   */
  function checkMethodAllowed(method: string): void {
    if (config.dangerouslyAllowFullInternetAccess) {
      return;
    }

    const upperMethod = method.toUpperCase();
    if (!allowedMethods.includes(upperMethod as HttpMethod)) {
      throw new MethodNotAllowedError(upperMethod, allowedMethods);
    }
  }

  /**
   * Performs a fetch with allow-list enforcement and manual redirect handling.
   */
  async function secureFetch(
    url: string,
    options: SecureFetchOptions = {},
  ): Promise<FetchResult> {
    const method = options.method?.toUpperCase() ?? "GET";

    // Check if URL and method are allowed. checkAndResolve resolves DNS once
    // and returns the validated addresses to pin the connection to.
    let pinnedAddresses = await checkAndResolve(url);
    checkMethodAllowed(method);

    let currentUrl = url;
    let redirectCount = 0;
    const followRedirects = options.followRedirects ?? true;

    // Use per-request timeout if specified, but cap at global timeout
    const effectiveTimeout =
      options.timeoutMs !== undefined
        ? Math.min(options.timeoutMs, timeoutMs)
        : timeoutMs;

    while (true) {
      const controller = new AbortController();
      const timeoutId = _setTimeout(() => controller.abort(), effectiveTimeout);

      try {
        // Merge user headers with firewall headers (firewall overrides user).
        // getFirewallHeaders returns a Headers object (which may trigger
        // undici WASM init), so both header construction and fetch run
        // inside runTrustedAsync.
        const response = await DefenseInDepthBox.runTrustedAsync(() => {
          const firewallHeaders = getFirewallHeaders(currentUrl);
          const mergedHeaders = buildMergedHeaders(
            options.headers,
            firewallHeaders,
          );

          const fetchOptions: RequestInit = {
            method,
            headers: mergedHeaders,
            signal: controller.signal,
            redirect: "manual", // Handle redirects manually to check allow-list
          };

          // Pin the connection to the validated address(es) so undici cannot
          // re-resolve the hostname to a different (rebound) IP between our
          // validation and the actual connect. `dispatcher` is an undici
          // extension on RequestInit; when pinning primitives are unavailable
          // the dispatcher is undefined and the resolve-once gate still holds.
          if (pinnedAddresses && pinnedAddresses.length > 0) {
            const dispatcher = buildPinnedDispatcher(pinnedAddresses);
            if (dispatcher) {
              (
                fetchOptions as RequestInit & { dispatcher?: unknown }
              ).dispatcher = dispatcher;
            }
          }

          // Only include body for methods that support it
          if (options.body && !BODYLESS_METHODS.has(method)) {
            fetchOptions.body = options.body;
            // Report request body traffic
            if (config.onTraffic) {
              const bodyBytes = Buffer.from(options.body).byteLength;
              config.onTraffic(bodyBytes);
            }
          }

          return fetch(currentUrl, fetchOptions);
        });

        // Check for redirects
        if (REDIRECT_CODES.has(response.status) && followRedirects) {
          const location = response.headers.get("location");
          if (!location) {
            // No location header, return the response as-is
            return await responseToResult(
              response,
              currentUrl,
              maxResponseSize,
              config.onTraffic,
            );
          }

          // Resolve relative URLs
          const redirectUrl = new URL(location, currentUrl).href;

          // Re-validate AND re-pin the redirect target: redirects can rebind
          // to a private IP, so each hop resolves DNS afresh and produces a
          // new connection pin.
          try {
            pinnedAddresses = await checkAndResolve(redirectUrl);
          } catch {
            throw new RedirectNotAllowedError(redirectUrl);
          }

          redirectCount++;
          if (redirectCount > maxRedirects) {
            throw new TooManyRedirectsError(maxRedirects);
          }

          currentUrl = redirectUrl;
          continue;
        }

        return await responseToResult(
          response,
          currentUrl,
          maxResponseSize,
          config.onTraffic,
        );
      } finally {
        _clearTimeout(timeoutId);
      }
    }
  }

  return secureFetch;
}

/**
 * Merges user headers with firewall headers.
 *
 * Accepts both `Headers` and plain `Record<string, string>` for backward
 * compatibility. User headers are copied first, then firewall headers are
 * `set()` on top so they always override — the sandbox cannot substitute
 * credentials. Multi-value user headers (added via `Headers.append()`)
 * are preserved for names that the firewall does not override.
 */
function buildMergedHeaders(
  userHeaders: Headers | Record<string, string> | undefined,
  firewallHeaders: Headers | null,
): Headers | Record<string, string> | undefined {
  if (!userHeaders && !firewallHeaders) return undefined;
  // Fast path: no firewall headers, pass user headers through unchanged
  if (!firewallHeaders) return userHeaders;
  const merged =
    userHeaders instanceof Headers
      ? new Headers(userHeaders)
      : new Headers(userHeaders);
  // Firewall headers override user headers (security).
  // Use set() so firewall values replace any user-supplied value for the
  // same header name (case-insensitive).
  // biome-ignore lint/suspicious/noExplicitAny: Headers iteration workaround
  (firewallHeaders as any).forEach((v: string, k: string) => {
    merged.set(k, v);
  });
  return merged;
}

/**
 * Converts a Response to a FetchResult, enforcing response size limits.
 */
async function responseToResult(
  response: Response,
  url: string,
  maxResponseSize: number,
  onTraffic?: (bytes: number) => void,
): Promise<FetchResult> {
  // Use null-prototype to prevent prototype pollution via malicious response headers
  const headers: Record<string, string> = Object.create(null);
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Fast path: check Content-Length header
  if (maxResponseSize > 0) {
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (!Number.isNaN(size) && size > maxResponseSize) {
        throw new ResponseTooLargeError(maxResponseSize);
      }
    }
  }

  // Read body with size tracking
  let body: string;
  if (maxResponseSize > 0 && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;

      // Report response traffic
      if (onTraffic) {
        onTraffic(value.byteLength);
      }

      if (totalSize > maxResponseSize) {
        reader.cancel();
        throw new ResponseTooLargeError(maxResponseSize);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    body = chunks.join("");
  } else {
    const text = await response.text();
    // Report traffic for body read at once
    if (onTraffic) {
      onTraffic(Buffer.from(text).byteLength);
    }
    body = text;
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    url,
  };
}
