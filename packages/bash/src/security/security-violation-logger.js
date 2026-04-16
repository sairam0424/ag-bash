/**
 * Security Violation Logger
 *
 * Utility for tracking and reporting security violations from the
 * defense-in-depth box. Useful for monitoring, alerting, and debugging.
 *
 * IMPORTANT: This is for monitoring a SECONDARY defense layer.
 * Violations indicate potential escape attempts but the primary
 * security should prevent these from being exploitable.
 */
/**
 * Security Violation Logger
 *
 * Collects and summarizes security violations for analysis.
 */
export class SecurityViolationLogger {
    violations = [];
    violationsByType = new Map();
    options;
    constructor(options = {}) {
        this.options = {
            maxViolationsPerType: options.maxViolationsPerType ?? 100,
            maxViolationsTotal: options.maxViolationsTotal ?? 1000,
            includeStackTraces: options.includeStackTraces ?? true,
            onViolation: options.onViolation ?? (() => { }),
            logToConsole: options.logToConsole ?? false,
        };
    }
    /**
     * Record a security violation.
     * This method is designed to be passed as the onViolation callback.
     */
    record(violation) {
        // Optionally strip stack trace
        const processedViolation = this.options.includeStackTraces
            ? violation
            : { ...violation, stack: undefined };
        // Store in main list (most recent first), capping total size
        this.violations.unshift(processedViolation);
        if (this.violations.length > this.options.maxViolationsTotal) {
            this.violations.length = this.options.maxViolationsTotal;
        }
        // Store by type
        let typeList = this.violationsByType.get(violation.type);
        if (!typeList) {
            typeList = [];
            this.violationsByType.set(violation.type, typeList);
        }
        // Add to type list with cap
        if (typeList.length < this.options.maxViolationsPerType) {
            typeList.push(processedViolation);
        }
        // Log to console if enabled
        if (this.options.logToConsole) {
            console.warn(`[SecurityViolation] ${violation.type}: ${violation.message}`, violation.path);
        }
        // Call custom handler
        this.options.onViolation(processedViolation);
    }
    /**
     * Get all recorded violations.
     */
    getViolations() {
        return [...this.violations];
    }
    /**
     * Get violations of a specific type.
     */
    getViolationsByType(type) {
        return [...(this.violationsByType.get(type) ?? [])];
    }
    /**
     * Get a summary of all violations by type.
     */
    getSummary() {
        const summaries = [];
        for (const [type, violations] of this.violationsByType) {
            if (violations.length === 0)
                continue;
            const paths = new Set();
            let firstSeen = Number.POSITIVE_INFINITY;
            let lastSeen = 0;
            for (const v of violations) {
                paths.add(v.path);
                firstSeen = Math.min(firstSeen, v.timestamp);
                lastSeen = Math.max(lastSeen, v.timestamp);
            }
            summaries.push({
                type,
                count: violations.length,
                firstSeen,
                lastSeen,
                paths: Array.from(paths),
            });
        }
        // Sort by count descending
        summaries.sort((a, b) => b.count - a.count);
        return summaries;
    }
    /**
     * Get total violation count.
     */
    getTotalCount() {
        return this.violations.length;
    }
    /**
     * Check if any violations have been recorded.
     */
    hasViolations() {
        return this.violations.length > 0;
    }
    /**
     * Clear all recorded violations.
     */
    clear() {
        this.violations = [];
        this.violationsByType.clear();
    }
    /**
     * Create a callback function suitable for DefenseInDepthConfig.onViolation.
     */
    createCallback() {
        return (violation) => this.record(violation);
    }
}
/**
 * Create a simple violation callback that logs to console.
 */
export function createConsoleViolationCallback() {
    return (violation) => {
        console.warn(`[DefenseInDepth] Security violation detected:`, `\n  Type: ${violation.type}`, `\n  Path: ${violation.path}`, `\n  Message: ${violation.message}`, violation.executionId ? `\n  ExecutionId: ${violation.executionId}` : "");
    };
}
