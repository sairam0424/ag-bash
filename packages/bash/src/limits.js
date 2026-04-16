/**
 * Execution Limits Configuration
 *
 * Centralized configuration for all execution limits to prevent runaway compute.
 * These limits can be overridden when creating a Bash instance.
 */
/**
 * Default execution limits.
 * These are conservative limits designed to prevent runaway execution
 * while allowing reasonable scripts to complete.
 */
const DEFAULT_LIMITS = {
    maxCallDepth: 100,
    maxCommandCount: 10000,
    maxLoopIterations: 10000,
    maxAwkIterations: 10000,
    maxSedIterations: 10000,
    maxJqIterations: 10000,
    maxSqliteTimeoutMs: 5000,
    maxPythonTimeoutMs: 10000,
    maxJsTimeoutMs: 10000,
    maxGlobOperations: 100000,
    maxStringLength: 10485760, // 10MB
    maxArrayElements: 100000,
    maxHeredocSize: 10485760, // 10MB
    maxSubstitutionDepth: 50,
    maxBraceExpansionResults: 10000,
    maxOutputSize: 10485760, // 10MB
    maxFileDescriptors: 1024,
    maxSourceDepth: 100,
};
/**
 * Resolve execution limits by merging user-provided limits with defaults.
 */
export function resolveLimits(userLimits) {
    if (!userLimits) {
        return { ...DEFAULT_LIMITS };
    }
    return {
        maxCallDepth: userLimits.maxCallDepth ?? DEFAULT_LIMITS.maxCallDepth,
        maxCommandCount: userLimits.maxCommandCount ?? DEFAULT_LIMITS.maxCommandCount,
        maxLoopIterations: userLimits.maxLoopIterations ?? DEFAULT_LIMITS.maxLoopIterations,
        maxAwkIterations: userLimits.maxAwkIterations ?? DEFAULT_LIMITS.maxAwkIterations,
        maxSedIterations: userLimits.maxSedIterations ?? DEFAULT_LIMITS.maxSedIterations,
        maxJqIterations: userLimits.maxJqIterations ?? DEFAULT_LIMITS.maxJqIterations,
        maxSqliteTimeoutMs: userLimits.maxSqliteTimeoutMs ?? DEFAULT_LIMITS.maxSqliteTimeoutMs,
        maxPythonTimeoutMs: userLimits.maxPythonTimeoutMs ?? DEFAULT_LIMITS.maxPythonTimeoutMs,
        maxJsTimeoutMs: userLimits.maxJsTimeoutMs ?? DEFAULT_LIMITS.maxJsTimeoutMs,
        maxGlobOperations: userLimits.maxGlobOperations ?? DEFAULT_LIMITS.maxGlobOperations,
        maxStringLength: userLimits.maxStringLength ?? DEFAULT_LIMITS.maxStringLength,
        maxArrayElements: userLimits.maxArrayElements ?? DEFAULT_LIMITS.maxArrayElements,
        maxHeredocSize: userLimits.maxHeredocSize ?? DEFAULT_LIMITS.maxHeredocSize,
        maxSubstitutionDepth: userLimits.maxSubstitutionDepth ?? DEFAULT_LIMITS.maxSubstitutionDepth,
        maxBraceExpansionResults: userLimits.maxBraceExpansionResults ??
            DEFAULT_LIMITS.maxBraceExpansionResults,
        maxOutputSize: userLimits.maxOutputSize ?? DEFAULT_LIMITS.maxOutputSize,
        maxFileDescriptors: userLimits.maxFileDescriptors ?? DEFAULT_LIMITS.maxFileDescriptors,
        maxSourceDepth: userLimits.maxSourceDepth ?? DEFAULT_LIMITS.maxSourceDepth,
    };
}
