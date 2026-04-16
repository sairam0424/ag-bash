/**
 * Pre-captured global references.
 *
 * Defense-in-depth replaces dangerous globals with blocking proxies during
 * bash execution. These pre-captured references are taken at module load
 * time (before defense patches are applied) so that ag-bash's own
 * infrastructure can use them safely.
 *
 * IMPORTANT: This module must be imported eagerly (at Bash construction time),
 * not lazily during exec(), to ensure the capture happens before patching.
 */
import { DefenseInDepthBox } from "./security/defense-in-depth-box.js";
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval.bind(globalThis);
function bindTimerCallback(callback) {
    if (typeof callback !== "function")
        return callback;
    return DefenseInDepthBox.bindCurrentContext(callback);
}
export const _setTimeout = ((callback, delay, ...args) => {
    return nativeSetTimeout(bindTimerCallback(callback), delay, ...args);
});
export const _clearTimeout = nativeClearTimeout;
export const _setInterval = ((callback, delay, ...args) => {
    return nativeSetInterval(bindTimerCallback(callback), delay, ...args);
});
export const _clearInterval = nativeClearInterval;
// _SharedArrayBuffer, _Atomics, _performanceNow moved to security/trusted-globals.ts
