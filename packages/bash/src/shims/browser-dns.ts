/**
 * Browser shim for node:dns
 *
 * DNS resolution is not available in the browser. This shim provides
 * a minimal implementation to satisfy the bundler while ensuring
 * that DNS-based private network protection fails safe (by blocking).
 */

export interface LookupAddress {
  address: string;
  family: number;
}

export interface LookupOptions {
  family?: number;
  hints?: number;
  all?: boolean;
  verbatim?: boolean;
}

export interface LookupOneOptions extends LookupOptions {
  all?: false;
}

export interface LookupAllOptions extends LookupOptions {
  all: true;
}

type LookupCallback = (err: Error | null, ...args: unknown[]) => void;

/**
 * Partial implementation of dns.lookup that always fails.
 */
export function lookup(
  hostname: string,
  callback: (err: Error | null, address: string, family: number) => void,
): void;
export function lookup(
  hostname: string,
  options: LookupAllOptions,
  callback: (err: Error | null, addresses: LookupAddress[]) => void,
): void;
export function lookup(
  hostname: string,
  options: LookupOneOptions,
  callback: (err: Error | null, address: string, family: number) => void,
): void;
export function lookup(
  hostname: string,
  options: LookupOptions | number,
  callback: (
    err: Error | null,
    address: string | LookupAddress[],
    family: number,
  ) => void,
): void;
// biome-ignore lint/suspicious/noExplicitAny: Implementation signature for overloads must be broad
export function lookup(
  hostname: string,
  optionsOrCallback: any,
  callbackOrNone?: any,
): void {
  const options =
    typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
  const callback =
    typeof optionsOrCallback === "function"
      ? (optionsOrCallback as LookupCallback)
      : (callbackOrNone as LookupCallback);

  const err = new Error(
    `DNS lookup for "${hostname}" is not supported in the browser.`,
  );
  // Add code to satisfy typical node error handling
  Object.assign(err, { code: "ENOTFOUND" });

  // Always return an error to prevent reaching private IPs by hostname
  // since we can't verify the resolved IP in the browser.
  setTimeout(() => {
    if (typeof options === "object" && (options as LookupOptions).all) {
      callback(err, []);
    } else {
      callback(err, null, 0);
    }
  }, 0);
}

const _default_1: {
  lookup: typeof lookup;
} = {
  lookup,
};
export default _default_1;
