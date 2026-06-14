/**
 * Shell-escape a value for safe interpolation in bash commands.
 * Uses single-quoting to prevent all interpretation.
 */
export function shellEscape(value: unknown): string {
  if (value === null || value === undefined) return "''";

  if (Array.isArray(value)) {
    return value.map(shellEscape).join(" ");
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  const str = String(value);

  // If it's safe (only alphanumeric, dash, underscore, dot, slash), no quoting needed
  if (/^[a-zA-Z0-9_\-./]+$/.test(str)) {
    return str;
  }

  // Single-quote the string, escaping any single quotes within it
  // In bash: replace ' with '\'' (end quote, escaped quote, start quote)
  return `'${str.replace(/'/g, "'\\''")}'`;
}
