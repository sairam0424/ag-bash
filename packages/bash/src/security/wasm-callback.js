import { sanitizeErrorMessage } from "../fs/sanitize-error.js";
export function sanitizeUnknownError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeErrorMessage(message);
}
/**
 * Wrap WASM-to-JS callbacks so callback failures are surfaced as sanitized
 * internal errors without leaking host/internal paths.
 */
export function wrapWasmCallback(component, phase, callback) {
  return (...args) => {
    try {
      return callback(...args);
    } catch (error) {
      const message = sanitizeUnknownError(error);
      throw new Error(`${component} ${phase} callback failed: ${message}`);
    }
  };
}
