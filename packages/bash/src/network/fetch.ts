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
import { sanitizeErrorMessage } from "../fs/sanitize-error.js";
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
 * Error thrown when the private-IP DNS lookup exceeds its bound. Carries
 * `code = "ETIMEDOUT"` so {@link checkAndResolve} handles a self-imposed bound
 * and a resolver-reported timeout identically: neither produced an address, so
 * NOTHING was range-checked and there is nothing to pin. Both must fail closed
 * — see {@link DnsResolutionUnverifiedError}.
 */
class DnsLookupTimeoutError extends Error {
  readonly code = "ETIMEDOUT" as const;
  constructor() {
    super("DNS lookup timed out");
    this.name = "DnsLookupTimeoutError";
  }
}

/**
 * Thrown when the hostname's resolution could not be VERIFIED, so the
 * private/metadata-range policy could not be applied to any address.
 *
 * Proceeding in that state is a fail-open: `fetch`'s dispatcher (undici)
 * resolves the hostname independently and has never seen the blocklist, so an
 * attacker who can make the first resolution slow or fail would obtain an
 * unvalidated connection. A request that cannot be validated is refused.
 *
 * Subclasses {@link NetworkAccessDeniedError} so the message keeps the
 * `Network access denied: …` prefix every existing caller matches on (curl's
 * exit-code mapping among them) while still being distinguishable by type.
 * The reason is a fixed, caller-independent string routed through
 * {@link sanitizeErrorMessage}: never resolver error text, never a resolved
 * address.
 */
export class DnsResolutionUnverifiedError extends NetworkAccessDeniedError {
  constructor(url: string, reason: string) {
    super(url, sanitizeErrorMessage(reason));
    this.name = "DnsResolutionUnverifiedError";
  }
}

/** Why a request proceeded without a connection pin. */
export type UnpinnedRequestReason = "pinning-unavailable" | "unresolved-host";

/** An observable record of one request that proceeded without a pin. */
export interface UnpinnedRequestRecord {
  readonly hostname: string;
  readonly reason: UnpinnedRequestReason;
}

/** Bound on the retained unpinned-request records (newest kept). */
const MAX_UNPINNED_RECORDS = 50;

let unpinnedRequests: readonly UnpinnedRequestRecord[] = [];
let unpinnedWarningEmitted = false;

/**
 * Records — and, once per process, loudly reports — a request that proceeded
 * without a connection pin.
 *
 * These requests are NOT unvalidated: the resolve-once/validate-all gate either
 * cleared every resolved address or the resolver definitively reported that the
 * host does not exist. What is missing is the pin, i.e. the guarantee that the
 * socket connects to the address that was validated, so the DNS-rebinding
 * window between validation and connect stays open. Silence about that is the
 * defect (U52): an operator would believe rebinding protection is active when
 * it is not.
 */
function recordUnpinnedRequest(
  hostname: string,
  reason: UnpinnedRequestReason,
): void {
  const appended = [...unpinnedRequests, { hostname, reason }];
  unpinnedRequests =
    appended.length > MAX_UNPINNED_RECORDS
      ? appended.slice(appended.length - MAX_UNPINNED_RECORDS)
      : appended;

  if (unpinnedWarningEmitted) return;
  unpinnedWarningEmitted = true;
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(
      `[ag-bash] network: a request proceeded WITHOUT a connection pin (${reason}). ` +
        "Resolved addresses were validated, but DNS rebinding between validation " +
        "and connect is not prevented for these requests. " +
        "Inspect getUnpinnedRequests() for details.",
    );
  }
}

/** All retained unpinned-request records, oldest first. */
export function getUnpinnedRequests(): readonly UnpinnedRequestRecord[] {
  return unpinnedRequests;
}

/** Drops retained records and re-arms the one-time warning. */
export function clearUnpinnedRequests(): void {
  unpinnedRequests = [];
  unpinnedWarningEmitted = false;
}

const DEFAULT_MAX_REDIRECTS = 20;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_SIZE = 10485760; // 10MB
const DEFAULT_ALLOWED_METHODS: HttpMethod[] = ["GET", "HEAD"];
/**
 * Upper bound for the private-range DNS lookup. The bound exists so a blocking
 * host resolver can never hang the caller; it still tracks the request timeout,
 * which only ever lowers it.
 *
 * This bound is now a REFUSAL threshold, not a skip threshold: exceeding it
 * fails the request closed (see {@link DnsResolutionUnverifiedError}). Back when
 * a timeout merely dropped the pin, an aggressive 1s cap was free. Under
 * fail-closed semantics that trade-off inverts — too tight a cap turns an
 * ordinary cold cross-continent lookup into a refused request — so the cap is
 * now generous enough for a real resolver while still strictly bounded.
 */
const DNS_LOOKUP_TIMEOUT_CAP_MS = 5000;

// DNS resolution for private IP check. Bounded so a blocking host resolver
// (offline/sandboxed environments where getaddrinfo can stall ~30s) can never
// hang the request. On timeout we reject with DnsLookupTimeoutError, and
// checkAndResolve fails the request closed: no address was obtained, so no
// address was validated.
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
 * {@link checkAndResolve} remains the authoritative protection — a state that
 * is now recorded via {@link recordUnpinnedRequest} instead of passing
 * silently.
 */
export type UndiciAgent = {
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
 * @internal Test seam. Overrides the cached pinning `Agent` factory so both the
 * pinned and the unpinned path can be exercised deterministically, independent
 * of whether `undici` happens to be resolvable in the host environment. Pass
 * `undefined` to restore lazy detection. Not re-exported from the package's
 * public entry points.
 */
export function _setPinningAgentFactory(
  factory: UndiciAgent | null | undefined,
): void {
  pinningAgentFactory = factory;
}

/**
 * Returns the IP family (4 or 6) for a pinned address literal.
 */
function familyOf(address: string): number {
  return address.includes(":") ? 6 : 4;
}

/**
 * Hostname of an already-validated URL, for observability records only. Returns
 * "" rather than throwing: a record must never be able to fail a request.
 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
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
   * A resolution that never completed is NOT a pass: it means no address was
   * range-checked, and `fetch` would then resolve the hostname itself with no
   * knowledge of the blocklist. Those cases fail closed.
   *
   * @returns the list of validated IP addresses to pin the connection to, or
   *   `null` when no pin is needed (denyPrivateRanges off, invalid URL) or when
   *   the resolver definitively reported the host does not exist (recorded via
   *   {@link recordUnpinnedRequest}).
   * @throws NetworkAccessDeniedError if the URL is not allowed
   * @throws DnsResolutionUnverifiedError if the resolution could not be
   *   verified (timed out, failed, or produced no address)
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
      const code = (dnsErr as NodeJS.ErrnoException)?.code;
      // ENOTFOUND/ENODATA: the resolver answered definitively — the name has no
      // address — so there is nothing to range-check and nothing to pin. Kept
      // as a pass-through, but recorded: `fetch` still resolves the name
      // itself, so the rebinding window is open for this hop.
      if (code === "ENOTFOUND" || code === "ENODATA") {
        recordUnpinnedRequest(hostname, "unresolved-host");
        return null;
      }
      // ETIMEDOUT (a resolver-reported timeout or our own DnsLookupTimeoutError)
      // is NOT an answer: the resolution did not complete, so no address was
      // validated. Previously this returned `null` — no pin AND no range check —
      // and undici then resolved the hostname independently, so anyone able to
      // slow the first resolution got an unvalidated connection. Fail closed.
      if (code === "ETIMEDOUT") {
        throw new DnsResolutionUnverifiedError(
          url,
          "DNS resolution timed out for private IP check",
        );
      }
      // Any other DNS error: fail closed (block).
      throw new DnsResolutionUnverifiedError(
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

    // An empty resolver result is the same fail-open shape as a timeout: the
    // call "succeeded" but validated nothing, so there is no pin and `fetch`
    // would resolve the hostname itself. Refuse rather than proceed blind.
    if (pinned.length === 0) {
      throw new DnsResolutionUnverifiedError(
        url,
        "DNS resolution returned no addresses for private IP check",
      );
    }
    return pinned;
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
          // extension on RequestInit; when the pinning primitives are
          // unavailable the dispatcher is undefined and the resolve-once gate
          // is the sole protection — recorded, never silent (U52).
          if (pinnedAddresses && pinnedAddresses.length > 0) {
            const dispatcher = buildPinnedDispatcher(pinnedAddresses);
            if (dispatcher) {
              (
                fetchOptions as RequestInit & { dispatcher?: unknown }
              ).dispatcher = dispatcher;
            } else {
              recordUnpinnedRequest(
                hostnameOf(currentUrl),
                "pinning-unavailable",
              );
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
