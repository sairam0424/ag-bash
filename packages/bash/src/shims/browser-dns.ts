/**
 * Browser shim for node:dns
 *
 * DNS resolution is not available in the browser. This shim provides
 * a minimal implementation to satisfy the bundler while ensuring
 * that DNS-based private network protection fails safe (by blocking).
 */

export function lookup(
  hostname: string,
  options: any,
  callback: (err: Error | null, address: string | null, family?: number) => void
): void {
  // If options is a callback, shift arguments
  const actualCallback = typeof options === 'function' ? options : callback;

  const err = new Error(`DNS lookup for "${hostname}" is not supported in the browser.`);
  (err as any).code = 'ENOTFOUND';

  // Always return an error to prevent reaching private IPs by hostname
  // since we can't verify the resolved IP in the browser.
  setTimeout(() => actualCallback(err, null), 0);
}

const _default_1: {
  lookup: typeof lookup;
} = {
  lookup,
};
export default _default_1;
