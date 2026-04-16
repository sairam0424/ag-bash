/**
 * Network configuration types
 *
 * Network access is disabled by default. To enable network access (e.g., for curl),
 * you must explicitly configure allowed URLs.
 */
/**
 * Error thrown when a URL is not allowed
 */
export class NetworkAccessDeniedError extends Error {
  constructor(url, reason) {
    const detail = reason ?? "URL not in allow-list";
    super(`Network access denied: ${detail}: ${url}`);
    this.name = "NetworkAccessDeniedError";
  }
}
/**
 * Error thrown when too many redirects occur
 */
export class TooManyRedirectsError extends Error {
  constructor(maxRedirects) {
    super(`Too many redirects (max: ${maxRedirects})`);
    this.name = "TooManyRedirectsError";
  }
}
/**
 * Error thrown when a redirect target is not allowed
 */
export class RedirectNotAllowedError extends Error {
  constructor(url) {
    super(`Redirect target not in allow-list: ${url}`);
    this.name = "RedirectNotAllowedError";
  }
}
/**
 * Error thrown when an HTTP method is not allowed
 */
export class MethodNotAllowedError extends Error {
  constructor(method, allowedMethods) {
    super(
      `HTTP method '${method}' not allowed. Allowed methods: ${allowedMethods.join(", ")}`,
    );
    this.name = "MethodNotAllowedError";
  }
}
/**
 * Error thrown when a response body exceeds the maximum allowed size
 */
export class ResponseTooLargeError extends Error {
  constructor(maxSize) {
    super(`Response body too large (max: ${maxSize} bytes)`);
    this.name = "ResponseTooLargeError";
  }
}
