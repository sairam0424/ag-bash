/**
 * Worker Defense-in-Depth
 *
 * A simplified version of DefenseInDepthBox designed for use in Worker threads.
 * Since workers have their own isolated V8 context, we don't need AsyncLocalStorage
 * to track execution context - the entire worker IS the sandboxed context.
 *
 * Key differences from DefenseInDepthBox:
 * - No AsyncLocalStorage (always blocks, no context tracking needed)
 * - Single activation model (apply patches once at worker startup)
 * - Violations reported via callback (typically postMessage to parent)
 *
 * Usage in a worker:
 * ```typescript
 * import { parentPort } from 'node:worker_threads';
 * import { WorkerDefenseInDepth } from '../security/worker-defense-in-depth.js';
 *
 * // Apply patches at worker startup
 * const defense = new WorkerDefenseInDepth({
 *   onViolation: (v) => parentPort?.postMessage({ type: 'security-violation', violation: v }),
 * });
 *
 * // All code in the worker is now protected
 * // Attempting Function, eval, etc. will throw SecurityViolationError
 * ```
 *
 * Constructor Protection:
 * Function.prototype.constructor returns a proxy that allows property reads
 * (e.g., `.constructor.name` for type introspection) but blocks invocation
 * (e.g., `.constructor("code")` for dynamic code execution).
 *
 * IMPORTANT: This is a SECONDARY defense layer. It should never be relied upon
 * as the primary security mechanism. The primary security comes from proper
 * sandboxing, input validation, and architectural constraints.
 *
 * Dynamic import() mitigation (three layers):
 * 1. Module._resolveFilename blocked — catches file-based specifiers
 * 2. Main-thread ESM loader hooks block data:/blob: URLs (not in workers)
 * 3. Filesystem restrictions — OverlayFs writes to memory only
 *
 * Note: ESM loader hooks are registered by DefenseInDepthBox in the main
 * thread. Workers inherit the hooks automatically. Worker-level registration
 * is not needed (and would require require('node:module') which is blocked).
 */
import { getBlockedGlobals } from "./blocked-globals.js";
/**
 * Suffix added to all security violation messages.
 */
const DEFENSE_IN_DEPTH_NOTICE = "\n\nThis is a defense-in-depth measure and indicates a bug in ag-bash. " +
    "Please report this to the project maintainers.";
/**
 * Error thrown when a security violation is detected.
 */
export class WorkerSecurityViolationError extends Error {
    violation;
    constructor(message, violation) {
        super(message + DEFENSE_IN_DEPTH_NOTICE);
        this.violation = violation;
        this.name = "WorkerSecurityViolationError";
    }
}
// Maximum number of violations to store (prevent memory issues)
const MAX_STORED_VIOLATIONS = 1000;
/**
 * Generate a random execution ID for correlation.
 */
function generateExecutionId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
/**
 * Worker Defense-in-Depth
 *
 * Applies security patches to dangerous JavaScript globals in a worker context.
 * Unlike DefenseInDepthBox, this is designed for workers where the entire
 * execution context is sandboxed.
 */
export class WorkerDefenseInDepth {
    config;
    isActivated = false;
    originalDescriptors = [];
    violations = [];
    executionId;
    /**
     * Original Proxy constructor, captured before patching.
     * This is captured at instance creation time to ensure we get the unpatched version.
     */
    originalProxy;
    /**
     * Recursion guard to prevent infinite loops when proxy traps trigger
     * code that accesses the same proxied object (e.g., process.env).
     */
    inTrap = false;
    /**
     * Create and activate the worker defense layer.
     *
     * @param config - Configuration for the defense layer
     */
    constructor(config) {
        // Capture original Proxy BEFORE any patching occurs
        // This ensures we can create blocking proxies even after patching
        this.originalProxy = Proxy;
        this.config = config;
        this.executionId = generateExecutionId();
        // Default to enabled if not explicitly set to false
        if (config.enabled !== false) {
            this.activate();
        }
    }
    /**
     * Get statistics about the defense layer.
     */
    getStats() {
        return {
            violationsBlocked: this.violations.length,
            violations: [...this.violations],
            isActive: this.isActivated,
        };
    }
    /**
     * Clear stored violations. Useful for testing.
     */
    clearViolations() {
        this.violations = [];
    }
    /**
     * Get the execution ID for this worker.
     */
    getExecutionId() {
        return this.executionId;
    }
    /**
     * Deactivate the defense layer and restore original globals.
     * Typically only needed for testing.
     */
    deactivate() {
        if (!this.isActivated) {
            return;
        }
        this.restorePatches();
        this.isActivated = false;
    }
    /**
     * Activate the defense layer by applying patches.
     */
    activate() {
        if (this.isActivated) {
            return;
        }
        this.applyPatches();
        this.isActivated = true;
    }
    /**
     * Get a human-readable path for a target object and property.
     */
    getPathForTarget(target, prop) {
        if (target === globalThis) {
            return `globalThis.${prop}`;
        }
        if (typeof process !== "undefined" && target === process) {
            return `process.${prop}`;
        }
        if (target === Error) {
            return `Error.${prop}`;
        }
        if (target === Function.prototype) {
            return `Function.prototype.${prop}`;
        }
        if (target === Object.prototype) {
            return `Object.prototype.${prop}`;
        }
        return `<object>.${prop}`;
    }
    /**
     * Record a violation and invoke the callback.
     * In worker context, blocking always happens (no audit mode context check).
     */
    recordViolation(type, path, message) {
        const violation = {
            timestamp: Date.now(),
            type,
            message,
            path,
            stack: new Error().stack,
            executionId: this.executionId,
        };
        // Store violation (with cap to prevent memory issues)
        if (this.violations.length < MAX_STORED_VIOLATIONS) {
            this.violations.push(violation);
        }
        // Invoke callback if configured (typically sends to parent thread)
        if (this.config.onViolation) {
            try {
                this.config.onViolation(violation);
            }
            catch (e) {
                // Ignore callback errors
                console.debug("[WorkerDefenseInDepth] onViolation callback threw:", e instanceof Error ? e.message : e);
            }
        }
        return violation;
    }
    /**
     * Create a blocking proxy for a function.
     * In worker context, always blocks (no context check needed).
     */
    createBlockingProxy(original, path, violationType) {
        const self = this;
        const auditMode = this.config.auditMode;
        // @banned-pattern-ignore: intentional Proxy usage for security blocking
        // Use this.originalProxy to avoid being blocked by our own patches
        return new this.originalProxy(original, {
            apply(target, thisArg, args) {
                const message = `${path} is blocked in worker context`;
                const violation = self.recordViolation(violationType, path, message);
                if (!auditMode) {
                    throw new WorkerSecurityViolationError(message, violation);
                }
                // Audit mode: log but allow
                return Reflect.apply(target, thisArg, args);
            },
            construct(target, args, newTarget) {
                const message = `${path} constructor is blocked in worker context`;
                const violation = self.recordViolation(violationType, path, message);
                if (!auditMode) {
                    throw new WorkerSecurityViolationError(message, violation);
                }
                // Audit mode: log but allow
                return Reflect.construct(target, args, newTarget);
            },
        });
    }
    /**
     * Create a blocking proxy for an object (blocks all property access).
     */
    createBlockingObjectProxy(original, path, violationType, allowedKeys) {
        const self = this;
        const auditMode = this.config.auditMode;
        // @banned-pattern-ignore: intentional Proxy usage for security blocking
        // Use this.originalProxy to avoid being blocked by our own patches
        return new this.originalProxy(original, {
            get(target, prop, receiver) {
                // Recursion guard: if we're already in a trap (e.g., recordViolation
                // triggers process.env access), just return the value to avoid infinite loop
                if (self.inTrap) {
                    return Reflect.get(target, prop, receiver);
                }
                // Allow specific keys through (e.g., Node.js internal env vars like FORCE_COLOR)
                if (allowedKeys && typeof prop === "string" && allowedKeys.has(prop)) {
                    return Reflect.get(target, prop, receiver);
                }
                self.inTrap = true;
                try {
                    const fullPath = `${path}.${String(prop)}`;
                    const message = `${fullPath} is blocked in worker context`;
                    const violation = self.recordViolation(violationType, fullPath, message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    return Reflect.get(target, prop, receiver);
                }
                finally {
                    self.inTrap = false;
                }
            },
            set(target, prop, value, receiver) {
                if (self.inTrap) {
                    return Reflect.set(target, prop, value, receiver);
                }
                self.inTrap = true;
                try {
                    const fullPath = `${path}.${String(prop)}`;
                    const message = `${fullPath} modification is blocked in worker context`;
                    const violation = self.recordViolation(violationType, fullPath, message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    return Reflect.set(target, prop, value, receiver);
                }
                finally {
                    self.inTrap = false;
                }
            },
            ownKeys(target) {
                if (self.inTrap) {
                    return Reflect.ownKeys(target);
                }
                self.inTrap = true;
                try {
                    const message = `${path} enumeration is blocked in worker context`;
                    const violation = self.recordViolation(violationType, path, message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    return Reflect.ownKeys(target);
                }
                finally {
                    self.inTrap = false;
                }
            },
            getOwnPropertyDescriptor(target, prop) {
                if (self.inTrap) {
                    return Reflect.getOwnPropertyDescriptor(target, prop);
                }
                self.inTrap = true;
                try {
                    const fullPath = `${path}.${String(prop)}`;
                    const message = `${fullPath} descriptor access is blocked in worker context`;
                    const violation = self.recordViolation(violationType, fullPath, message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    return Reflect.getOwnPropertyDescriptor(target, prop);
                }
                finally {
                    self.inTrap = false;
                }
            },
            has(target, prop) {
                if (self.inTrap) {
                    return Reflect.has(target, prop);
                }
                self.inTrap = true;
                try {
                    const fullPath = `${path}.${String(prop)}`;
                    const message = `${fullPath} existence check is blocked in worker context`;
                    const violation = self.recordViolation(violationType, fullPath, message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    return Reflect.has(target, prop);
                }
                finally {
                    self.inTrap = false;
                }
            },
            deleteProperty(target, prop) {
                if (self.inTrap) {
                    return Reflect.deleteProperty(target, prop);
                }
                self.inTrap = true;
                try {
                    const fullPath = `${path}.${String(prop)}`;
                    const message = `${fullPath} deletion is blocked in worker context`;
                    const violation = self.recordViolation(violationType, fullPath, message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    return Reflect.deleteProperty(target, prop);
                }
                finally {
                    self.inTrap = false;
                }
            },
            setPrototypeOf(target, proto) {
                if (self.inTrap) {
                    return Reflect.setPrototypeOf(target, proto);
                }
                self.inTrap = true;
                try {
                    const message = `${path} setPrototypeOf is blocked in worker context`;
                    const violation = self.recordViolation(violationType, path, message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    return Reflect.setPrototypeOf(target, proto);
                }
                finally {
                    self.inTrap = false;
                }
            },
            defineProperty(target, prop, descriptor) {
                if (self.inTrap) {
                    return Reflect.defineProperty(target, prop, descriptor);
                }
                self.inTrap = true;
                try {
                    const fullPath = `${path}.${String(prop)}`;
                    const message = `${fullPath} defineProperty is blocked in worker context`;
                    const violation = self.recordViolation(violationType, fullPath, message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    return Reflect.defineProperty(target, prop, descriptor);
                }
                finally {
                    self.inTrap = false;
                }
            },
        });
    }
    /**
     * Apply security patches to dangerous globals.
     */
    applyPatches() {
        const blockedGlobals = getBlockedGlobals();
        const excludeTypes = new Set(this.config.excludeViolationTypes ?? []);
        for (const blocked of blockedGlobals) {
            // Skip globals that are explicitly excluded
            if (excludeTypes.has(blocked.violationType)) {
                continue;
            }
            this.applyPatch(blocked);
        }
        // Protect against .constructor.constructor escape vector
        // (only if function constructors are not excluded)
        if (!excludeTypes.has("function_constructor")) {
            this.protectConstructorChain(excludeTypes);
        }
        // Protect Error.prepareStackTrace
        // (only if not excluded)
        if (!excludeTypes.has("error_prepare_stack_trace")) {
            this.protectErrorPrepareStackTrace();
        }
        // Protect Module._load and Module._resolveFilename BEFORE process.mainModule,
        // since these methods need to read process.mainModule to find the Module class.
        if (!excludeTypes.has("module_load")) {
            this.protectModuleLoad();
        }
        if (!excludeTypes.has("module_resolve_filename")) {
            this.protectModuleResolveFilename();
        }
        // Protect process.mainModule (may be undefined in ESM but still blockable)
        if (!excludeTypes.has("process_main_module")) {
            this.protectProcessMainModule();
        }
        // Protect process.execPath (string primitive, needs defineProperty)
        if (!excludeTypes.has("process_exec_path")) {
            this.protectProcessExecPath();
        }
        // Protect process.connected (boolean primitive, needs defineProperty)
        if (!excludeTypes.has("process_connected")) {
            this.protectProcessConnected();
        }
        // Lock well-known Symbol properties to prevent hijacking
        this.lockWellKnownSymbols();
        // Block Proxy.revocable to prevent bypassing Proxy constructor blocking
        if (!excludeTypes.has("proxy")) {
            this.protectProxyRevocable();
        }
    }
    /**
     * Lock well-known Symbol properties on built-in constructors/prototypes.
     */
    lockWellKnownSymbols() {
        const lock = (obj, sym) => {
            try {
                const desc = Object.getOwnPropertyDescriptor(obj, sym);
                if (desc?.configurable) {
                    if ("value" in desc) {
                        // Data descriptors must also be non-writable, otherwise assignment
                        // can still replace the Symbol property value.
                        Object.defineProperty(obj, sym, {
                            ...desc,
                            configurable: false,
                            writable: false,
                        });
                        return;
                    }
                    Object.defineProperty(obj, sym, { ...desc, configurable: false });
                }
            }
            catch {
                // Best-effort
            }
        };
        // biome-ignore lint/style/noRestrictedGlobals: intentional access to built-in RegExp constructor for security locking
        for (const ctor of [Array, Map, Set, RegExp, Promise]) {
            lock(ctor, Symbol.species);
        }
        for (const proto of [
            Array.prototype,
            String.prototype,
            Map.prototype,
            Set.prototype,
        ]) {
            lock(proto, Symbol.iterator);
        }
        lock(Symbol.prototype, Symbol.toPrimitive);
        lock(Date.prototype, Symbol.toPrimitive);
        // Lock RegExp Symbol methods (controls String.prototype.match/replace/search/split behavior)
        for (const sym of [
            Symbol.match,
            Symbol.matchAll,
            Symbol.replace,
            Symbol.search,
            Symbol.split,
        ]) {
            // biome-ignore lint/style/noRestrictedGlobals: intentional access to built-in RegExp prototype for security locking
            lock(RegExp.prototype, sym);
        }
        // Lock Symbol.hasInstance (controls instanceof behavior)
        lock(Function.prototype, Symbol.hasInstance);
        // Lock Symbol.unscopables (controls with-statement scoping)
        lock(Array.prototype, Symbol.unscopables);
        // Lock Symbol.toStringTag (prevents type spoofing via Object.prototype.toString)
        for (const proto of [
            Map.prototype,
            Set.prototype,
            Promise.prototype,
            ArrayBuffer.prototype,
        ]) {
            lock(proto, Symbol.toStringTag);
        }
        // Freeze Error.stackTraceLimit to prevent stack trace depth manipulation.
        // Uses configurable: true so it can be restored on deactivation.
        try {
            const stackDesc = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
            this.originalDescriptors.push({
                target: Error,
                prop: "stackTraceLimit",
                descriptor: stackDesc,
            });
            Object.defineProperty(Error, "stackTraceLimit", {
                value: Error.stackTraceLimit,
                writable: false,
                configurable: true,
            });
        }
        catch {
            /* best-effort */
        }
    }
    /**
     * Block Proxy.revocable to prevent bypassing Proxy constructor blocking.
     *
     * Proxy.revocable internally uses the real Proxy constructor, so it bypasses
     * our blocking proxy on globalThis.Proxy. We replace it with a wrapper that
     * always blocks in worker context.
     */
    protectProxyRevocable() {
        const self = this;
        const auditMode = this.config.auditMode;
        try {
            const originalRevocable = this.originalProxy.revocable;
            if (typeof originalRevocable !== "function")
                return;
            const descriptor = Object.getOwnPropertyDescriptor(this.originalProxy, "revocable");
            this.originalDescriptors.push({
                target: this.originalProxy,
                prop: "revocable",
                descriptor,
            });
            Object.defineProperty(this.originalProxy, "revocable", {
                value: function revocable(_target, _handler) {
                    const message = "Proxy.revocable is blocked in worker context";
                    const violation = self.recordViolation("proxy", "Proxy.revocable", message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    return originalRevocable(_target, _handler);
                },
                writable: false,
                configurable: true, // Must be configurable for restoration
            });
        }
        catch {
            // Could not protect Proxy.revocable
        }
    }
    /**
     * Protect against .constructor.constructor escape vector.
     * @param excludeTypes - Set of violation types to skip
     */
    protectConstructorChain(excludeTypes) {
        // Capture all constructors BEFORE patching to avoid triggering our own patches
        let AsyncFunction = null;
        let GeneratorFunction = null;
        let AsyncGeneratorFunction = null;
        try {
            AsyncFunction = Object.getPrototypeOf(async () => { }).constructor;
        }
        catch {
            // Not available
        }
        try {
            GeneratorFunction = Object.getPrototypeOf(function* () { }).constructor;
        }
        catch {
            // Not available
        }
        try {
            AsyncGeneratorFunction = Object.getPrototypeOf(async function* () { }).constructor;
        }
        catch {
            // Not available
        }
        // Now apply patches (order doesn't matter since we already captured constructors)
        // Always patch Function.prototype.constructor (base case)
        this.patchPrototypeConstructor(Function.prototype, "Function.prototype.constructor", "function_constructor");
        // AsyncFunction (skip if async_function_constructor is excluded)
        if (!excludeTypes.has("async_function_constructor") &&
            AsyncFunction &&
            AsyncFunction !== Function) {
            this.patchPrototypeConstructor(AsyncFunction.prototype, "AsyncFunction.prototype.constructor", "async_function_constructor");
        }
        // GeneratorFunction (skip if generator_function_constructor is excluded)
        if (!excludeTypes.has("generator_function_constructor") &&
            GeneratorFunction &&
            GeneratorFunction !== Function) {
            this.patchPrototypeConstructor(GeneratorFunction.prototype, "GeneratorFunction.prototype.constructor", "generator_function_constructor");
        }
        // AsyncGeneratorFunction (skip if async_generator_function_constructor is excluded)
        if (!excludeTypes.has("async_generator_function_constructor") &&
            AsyncGeneratorFunction &&
            AsyncGeneratorFunction !== Function &&
            AsyncGeneratorFunction !== AsyncFunction) {
            this.patchPrototypeConstructor(AsyncGeneratorFunction.prototype, "AsyncGeneratorFunction.prototype.constructor", "async_generator_function_constructor");
        }
    }
    /**
     * Protect Error.prepareStackTrace from being set.
     */
    protectErrorPrepareStackTrace() {
        const self = this;
        const auditMode = this.config.auditMode;
        try {
            const originalDescriptor = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
            this.originalDescriptors.push({
                target: Error,
                prop: "prepareStackTrace",
                descriptor: originalDescriptor,
            });
            let currentValue = originalDescriptor?.value;
            Object.defineProperty(Error, "prepareStackTrace", {
                get() {
                    return currentValue;
                },
                set(value) {
                    const message = "Error.prepareStackTrace modification is blocked in worker context";
                    const violation = self.recordViolation("error_prepare_stack_trace", "Error.prepareStackTrace", message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    currentValue = value;
                },
                configurable: true,
            });
        }
        catch {
            // Could not protect Error.prepareStackTrace
        }
    }
    /**
     * Patch a prototype's constructor property.
     *
     * Returns a proxy that allows reading properties (like .name) but blocks
     * calling the constructor as a function (which would allow code execution).
     */
    patchPrototypeConstructor(prototype, path, violationType) {
        const self = this;
        const auditMode = this.config.auditMode;
        try {
            const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
            this.originalDescriptors.push({
                target: prototype,
                prop: "constructor",
                descriptor: originalDescriptor,
            });
            const originalValue = originalDescriptor?.value;
            // Create a proxy that allows property reads but blocks invocation
            // This allows obj.constructor.name (needed by Pyodide) but blocks
            // obj.constructor("malicious code") which would create new functions
            // @banned-pattern-ignore: intentional Proxy usage for security blocking
            const constructorProxy = originalValue && typeof originalValue === "function"
                ? new this.originalProxy(originalValue, {
                    apply(_target, _thisArg, _args) {
                        const message = `${path} invocation is blocked in worker context`;
                        const violation = self.recordViolation(violationType, path, message);
                        if (!auditMode) {
                            throw new WorkerSecurityViolationError(message, violation);
                        }
                        // In audit mode, still block execution but log
                        return undefined;
                    },
                    construct(_target, _args, _newTarget) {
                        const message = `${path} construction is blocked in worker context`;
                        const violation = self.recordViolation(violationType, path, message);
                        if (!auditMode) {
                            throw new WorkerSecurityViolationError(message, violation);
                        }
                        // In audit mode, still block but log
                        return {};
                    },
                    // Allow all property access (like .name, .prototype, etc.)
                    get(target, prop, receiver) {
                        return Reflect.get(target, prop, receiver);
                    },
                    getPrototypeOf(target) {
                        return Reflect.getPrototypeOf(target);
                    },
                    has(target, prop) {
                        return Reflect.has(target, prop);
                    },
                    ownKeys(target) {
                        return Reflect.ownKeys(target);
                    },
                    getOwnPropertyDescriptor(target, prop) {
                        return Reflect.getOwnPropertyDescriptor(target, prop);
                    },
                })
                : originalValue;
            Object.defineProperty(prototype, "constructor", {
                get() {
                    // Return the proxy that allows reads but blocks invocation
                    return constructorProxy;
                },
                set(value) {
                    const message = `${path} modification is blocked in worker context`;
                    const violation = self.recordViolation(violationType, path, message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    Object.defineProperty(this, "constructor", {
                        value,
                        writable: true,
                        configurable: true,
                    });
                },
                configurable: true,
            });
        }
        catch {
            // Could not patch constructor
        }
    }
    /**
     * Protect process.mainModule from being accessed or set.
     *
     * The attack vector is:
     * ```
     * process.mainModule.require('child_process').execSync('whoami')
     * process.mainModule.constructor._load('vm')
     * ```
     *
     * process.mainModule may be undefined in ESM contexts but could exist in
     * CommonJS workers. We block both reading and setting.
     */
    protectProcessMainModule() {
        if (typeof process === "undefined")
            return;
        const self = this;
        const auditMode = this.config.auditMode;
        try {
            const originalDescriptor = Object.getOwnPropertyDescriptor(process, "mainModule");
            this.originalDescriptors.push({
                target: process,
                prop: "mainModule",
                descriptor: originalDescriptor,
            });
            // Only protect if mainModule exists (CJS contexts).
            // In ESM/workers, mainModule is undefined and Node.js internals
            // (createRequire) access this property during module loading -
            // blocking it would crash the worker silently.
            const currentValue = originalDescriptor?.value;
            if (currentValue !== undefined) {
                Object.defineProperty(process, "mainModule", {
                    get() {
                        const message = "process.mainModule access is blocked in worker context";
                        const violation = self.recordViolation("process_main_module", "process.mainModule", message);
                        if (!auditMode) {
                            throw new WorkerSecurityViolationError(message, violation);
                        }
                        return currentValue;
                    },
                    set(value) {
                        const message = "process.mainModule modification is blocked in worker context";
                        const violation = self.recordViolation("process_main_module", "process.mainModule", message);
                        if (!auditMode) {
                            throw new WorkerSecurityViolationError(message, violation);
                        }
                        Object.defineProperty(process, "mainModule", {
                            value,
                            writable: true,
                            configurable: true,
                        });
                    },
                    configurable: true,
                });
            }
        }
        catch {
            // Could not protect process.mainModule
        }
    }
    /**
     * Protect process.execPath from being read or set in worker context.
     *
     * process.execPath is a string primitive (not an object), so it cannot be
     * proxied via the normal blocked globals mechanism. We use Object.defineProperty
     * with getter/setter (same pattern as protectProcessMainModule).
     */
    protectProcessExecPath() {
        if (typeof process === "undefined")
            return;
        const self = this;
        const auditMode = this.config.auditMode;
        try {
            const originalDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
            this.originalDescriptors.push({
                target: process,
                prop: "execPath",
                descriptor: originalDescriptor,
            });
            const currentValue = originalDescriptor?.value ?? process.execPath;
            Object.defineProperty(process, "execPath", {
                get() {
                    const message = "process.execPath access is blocked in worker context";
                    const violation = self.recordViolation("process_exec_path", "process.execPath", message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    return currentValue;
                },
                set(value) {
                    const message = "process.execPath modification is blocked in worker context";
                    const violation = self.recordViolation("process_exec_path", "process.execPath", message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    Object.defineProperty(process, "execPath", {
                        value,
                        writable: true,
                        configurable: true,
                    });
                },
                configurable: true,
            });
        }
        catch {
            // Could not protect process.execPath
        }
    }
    /**
     * Protect process.connected from being read or set in worker context.
     *
     * process.connected is a boolean primitive (not an object), so it cannot be
     * proxied via the normal blocked globals mechanism. We use Object.defineProperty
     * with getter/setter (same pattern as protectProcessExecPath).
     *
     * Only protects if process.connected exists (IPC contexts).
     */
    protectProcessConnected() {
        if (typeof process === "undefined")
            return;
        // Only protect if connected exists (IPC context)
        if (process.connected === undefined)
            return;
        const self = this;
        const auditMode = this.config.auditMode;
        try {
            const originalDescriptor = Object.getOwnPropertyDescriptor(process, "connected");
            this.originalDescriptors.push({
                target: process,
                prop: "connected",
                descriptor: originalDescriptor,
            });
            const currentValue = originalDescriptor?.value ?? process.connected;
            Object.defineProperty(process, "connected", {
                get() {
                    const message = "process.connected access is blocked in worker context";
                    const violation = self.recordViolation("process_connected", "process.connected", message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    return currentValue;
                },
                set(value) {
                    const message = "process.connected modification is blocked in worker context";
                    const violation = self.recordViolation("process_connected", "process.connected", message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    Object.defineProperty(process, "connected", {
                        value,
                        writable: true,
                        configurable: true,
                    });
                },
                configurable: true,
            });
        }
        catch {
            // Could not protect process.connected
        }
    }
    /**
     * Protect Module._load from being called.
     *
     * The attack vector is:
     * ```
     * module.constructor._load('child_process')
     * require.main.constructor._load('vm')
     * ```
     *
     * We access the Module class and replace _load with a blocking proxy.
     */
    protectModuleLoad() {
        const self = this;
        const auditMode = this.config.auditMode;
        try {
            let ModuleClass = null;
            // Path 1: via process.mainModule (CJS contexts)
            if (typeof process !== "undefined") {
                const mainModule = process
                    .mainModule;
                if (mainModule && typeof mainModule === "object") {
                    ModuleClass = mainModule
                        .constructor;
                }
            }
            // Path 2: via require.main (CJS contexts)
            if (!ModuleClass &&
                typeof require !== "undefined" &&
                typeof require.main !== "undefined") {
                ModuleClass = require.main
                    .constructor;
            }
            if (!ModuleClass || typeof ModuleClass._load !== "function") {
                return;
            }
            const original = ModuleClass._load;
            const descriptor = Object.getOwnPropertyDescriptor(ModuleClass, "_load");
            this.originalDescriptors.push({
                target: ModuleClass,
                prop: "_load",
                descriptor,
            });
            const path = "Module._load";
            // @banned-pattern-ignore: intentional Proxy usage for security blocking
            const proxy = new this.originalProxy(original, {
                apply(_target, _thisArg, _args) {
                    const message = `${path} is blocked in worker context`;
                    const violation = self.recordViolation("module_load", path, message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    return Reflect.apply(_target, _thisArg, _args);
                },
            });
            Object.defineProperty(ModuleClass, "_load", {
                value: proxy,
                writable: true,
                configurable: true,
            });
        }
        catch {
            // Could not protect Module._load (expected in ESM contexts)
        }
    }
    /**
     * Protect Module._resolveFilename from being called in worker context.
     *
     * Module._resolveFilename is called for both require() and import() resolution.
     * Blocking it catches file-based import() specifiers.
     *
     * data: and blob: URLs are handled by ESM loader hooks registered
     * in the main thread (DefenseInDepthBox.protectDynamicImport).
     */
    protectModuleResolveFilename() {
        const self = this;
        const auditMode = this.config.auditMode;
        try {
            let ModuleClass = null;
            if (typeof process !== "undefined") {
                const mainModule = process
                    .mainModule;
                if (mainModule && typeof mainModule === "object") {
                    ModuleClass = mainModule
                        .constructor;
                }
            }
            if (!ModuleClass &&
                typeof require !== "undefined" &&
                typeof require.main !== "undefined") {
                ModuleClass = require.main
                    .constructor;
            }
            if (!ModuleClass || typeof ModuleClass._resolveFilename !== "function") {
                return;
            }
            const original = ModuleClass._resolveFilename;
            const descriptor = Object.getOwnPropertyDescriptor(ModuleClass, "_resolveFilename");
            this.originalDescriptors.push({
                target: ModuleClass,
                prop: "_resolveFilename",
                descriptor,
            });
            const path = "Module._resolveFilename";
            // @banned-pattern-ignore: intentional Proxy usage for security blocking
            const proxy = new this.originalProxy(original, {
                apply(_target, _thisArg, _args) {
                    const message = `${path} is blocked in worker context`;
                    const violation = self.recordViolation("module_resolve_filename", path, message);
                    if (!auditMode) {
                        throw new WorkerSecurityViolationError(message, violation);
                    }
                    return Reflect.apply(_target, _thisArg, _args);
                },
            });
            Object.defineProperty(ModuleClass, "_resolveFilename", {
                value: proxy,
                writable: true,
                configurable: true,
            });
        }
        catch {
            // Could not protect Module._resolveFilename (expected in ESM contexts)
        }
    }
    /**
     * Apply a single patch to a blocked global.
     */
    applyPatch(blocked) {
        const { target, prop, violationType, strategy } = blocked;
        try {
            const original = target[prop];
            if (original === undefined) {
                return;
            }
            const descriptor = Object.getOwnPropertyDescriptor(target, prop);
            this.originalDescriptors.push({ target, prop, descriptor });
            if (strategy === "freeze") {
                if (typeof original === "object" && original !== null) {
                    Object.freeze(original);
                }
            }
            else {
                const path = this.getPathForTarget(target, prop);
                // @banned-pattern-ignore: intentional check for function type in security code
                const proxy = typeof original === "function"
                    ? this.createBlockingProxy(original, path, violationType)
                    : this.createBlockingObjectProxy(original, path, violationType, blocked.allowedKeys);
                Object.defineProperty(target, prop, {
                    value: proxy,
                    writable: true,
                    configurable: true,
                });
            }
        }
        catch {
            // Could not patch
        }
    }
    /**
     * Restore all original values.
     */
    restorePatches() {
        for (let i = this.originalDescriptors.length - 1; i >= 0; i--) {
            const { target, prop, descriptor } = this.originalDescriptors[i];
            try {
                if (descriptor) {
                    Object.defineProperty(target, prop, descriptor);
                }
                else {
                    delete target[prop];
                }
            }
            catch {
                // Could not restore
            }
        }
        this.originalDescriptors = [];
    }
}
