# Error Codes Reference

## Exit Codes

| Exit Code | Error Type | Cause | Fix |
|-----------|-----------|-------|-----|
| 1 | General failure | Command returned non-zero | Check command output |
| 2 | Parse error | Syntax error in script | Fix script syntax |
| 126 | ExecutionLimitError | Resource limit exceeded | Increase `executionLimits.*` |
| 127 | Command not found | Unknown command | Check spelling, use `commands` |
| 128+N | Signal N | Process killed by signal | Check resource limits |
| 130 | SIGINT (Ctrl+C) | User interruption | Expected behavior |

## Structured Errors

All ag-bash errors extend base types with additional context:

### ExecutionLimitError

Thrown when a configured execution limit is exceeded (e.g., max output size, max recursion depth, max execution time).

```typescript
interface ExecutionLimitError extends Error {
  limitName: string;      // e.g., "maxOutputSize", "maxRecursionDepth"
  currentValue: number;   // The value that exceeded the limit
  maxValue: number;       // The configured maximum
}
```

**Common causes:**
- Infinite loops producing unbounded output
- Deeply nested function calls
- Long-running scripts exceeding wall-clock timeout

**Fix:** Increase the relevant limit in `executionLimits` config, or fix the script to avoid unbounded behavior.

### SecurityViolationError

Thrown when a command attempts an operation blocked by the DefenseInDepthBox security layer.

```typescript
interface SecurityViolationError extends Error {
  violation: string;  // Description of what was blocked and why
}
```

**Common causes:**
- Attempting to access paths outside the allowed filesystem root
- Running blocked commands (e.g., `rm -rf /`)
- Network access without configured allowlist

**Fix:** Configure the `DefenseInDepthBox` to allow the operation, or restructure your script to avoid the violation.

### ExitError

Thrown when using `bash.exec()` with `throwOnError: true` and the command exits non-zero.

```typescript
interface ExitError extends Error {
  stdout: string;    // Standard output up to the point of failure
  stderr: string;    // Standard error output
  exitCode: number;  // The non-zero exit code
}
```

### ExecutionAbortedError

Thrown when execution is cancelled via an AbortSignal (e.g., timeout, user cancellation).

```typescript
interface ExecutionAbortedError extends Error {
  reason: string;  // Why execution was aborted (e.g., "timeout", "user_cancel")
}
```

## Observations

In addition to exit codes, ag-bash provides structured `Observation` objects on `ExecResult.observations` for richer error context:

| Observation Type | Meaning |
|-----------------|---------|
| `command_not_found` | The command does not exist in the registry |
| `file_not_found` | A referenced file path does not exist |
| `directory_not_found` | A referenced directory does not exist |
| `permission_denied` | Operation blocked by filesystem permissions |
| `limit_exceeded` | An execution limit was hit |
| `syntax_error` | The script could not be parsed |
| `security_violation` | Blocked by DefenseInDepthBox |
| `suggestion` | A helpful hint (e.g., "did you mean...") |

### Example

```typescript
const result = await bash.exec("gti status");

if (result.observations?.length) {
  for (const obs of result.observations) {
    console.log(obs.type);        // "command_not_found"
    console.log(obs.message);     // "gti: command not found"
    console.log(obs.suggestions); // ["git"]
  }
}
```
