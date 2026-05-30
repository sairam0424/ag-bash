/**
 * MCP protocol-version negotiation + response shaping.
 *
 * The server can speak both the legacy `2024-11-05` revision (serialized-JSON
 * text-content responses only) and the modern `2025-06-18` revision
 * (`structuredContent` + `outputSchema`, `resource_link` content items). We
 * feature-detect via the `initialize` handshake and degrade gracefully so old
 * clients are never hard-broken.
 */

/** Protocol revision this server prefers when the client supports it. */
export const LATEST_PROTOCOL_VERSION = "2025-06-18";

/** Legacy protocol revision used as the back-compat fallback. */
export const LEGACY_PROTOCOL_VERSION = "2024-11-05";

/** Protocol revisions this server understands, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  "2025-06-18",
  "2025-03-26",
  LEGACY_PROTOCOL_VERSION,
];

/** Result of negotiating a protocol version with a connecting client. */
export interface NegotiatedProtocol {
  /** The protocol version echoed back in the initialize result. */
  version: string;
  /** Whether the negotiated revision supports structured content + outputSchema. */
  supportsStructured: boolean;
}

/**
 * MCP date-stamped revisions are lexicographically ordered (YYYY-MM-DD), so a
 * plain string comparison is a valid "is at least" check.
 */
function isAtLeast(version: string, floor: string): boolean {
  return version >= floor;
}

/**
 * Negotiate the protocol version from the client's `initialize` request.
 *
 * Rules (back-compat first, never hard-break old clients):
 *  - If the client requests a revision we support exactly, echo it back.
 *  - If the client requests a NEWER (unknown future) revision, answer with our
 *    latest supported revision (the client is expected to adapt or disconnect).
 *  - If the client requests an OLDER/unknown legacy revision, fall back to the
 *    legacy revision so serialized-JSON text responses still work.
 *  - If the client omits the field entirely, assume legacy.
 *
 * `supportsStructured` is true only when the negotiated revision is >= the
 * first revision that introduced `structuredContent`/`outputSchema`
 * (`2025-06-18`).
 */
export function negotiateProtocol(requested: unknown): NegotiatedProtocol {
  const requestedVersion =
    typeof requested === "string" && requested.length > 0
      ? requested
      : LEGACY_PROTOCOL_VERSION;

  let version: string;
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)) {
    // Exact match: honor exactly what the client asked for.
    version = requestedVersion;
  } else if (isAtLeast(requestedVersion, LATEST_PROTOCOL_VERSION)) {
    // Newer-than-we-know: offer our latest and let the client adapt.
    version = LATEST_PROTOCOL_VERSION;
  } else {
    // Older/unknown legacy dialect: stay safe on the legacy revision.
    version = LEGACY_PROTOCOL_VERSION;
  }

  return {
    version,
    supportsStructured: isAtLeast(version, LATEST_PROTOCOL_VERSION),
  };
}
