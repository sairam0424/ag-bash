/**
 * Lightweight Argument Parser for Custom Commands
 *
 * Parses POSIX-style flags and positional arguments from a string array.
 * Supports --flag, --flag=value, --flag value, -f, -f value, and -- separator.
 */

export interface ParsedArgs {
  /** Parsed flags: --flag=value → Map("flag", "value"), --flag (boolean) → Map("flag", true) */
  flags: Map<string, string | true>;
  /** Non-flag arguments in order */
  positional: string[];
  /** Check whether a flag was provided */
  has(flag: string): boolean;
  /** Get the string value of a flag (returns undefined for boolean flags or missing flags) */
  get(flag: string): string | undefined;
}

export interface ParseArgsOptions {
  /** Flags that never consume the next argument (always boolean true) */
  booleanFlags?: string[];
}

/**
 * Parse an argument array into structured flags and positional args.
 *
 * @example
 * ```ts
 * const parsed = parseArgs(["--verbose", "--out=build", "src/index.ts"]);
 * parsed.has("verbose"); // true
 * parsed.get("out");     // "build"
 * parsed.positional;     // ["src/index.ts"]
 * ```
 */
export function parseArgs(
  args: string[],
  options?: ParseArgsOptions,
): ParsedArgs {
  const booleanSet = new Set(options?.booleanFlags ?? []);
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  let stopFlags = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // After --, everything is positional
    if (stopFlags) {
      positional.push(arg);
      continue;
    }

    // -- separator
    if (arg === "--") {
      stopFlags = true;
      continue;
    }

    // Long flag: --name or --name=value
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const name = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        flags.set(name, value);
      } else {
        const name = arg.slice(2);
        if (booleanSet.has(name)) {
          flags.set(name, true);
        } else {
          // Peek at next arg — if it looks like a flag or there's nothing left, treat as boolean
          const next = args[i + 1];
          if (next === undefined || next.startsWith("-")) {
            flags.set(name, true);
          } else {
            flags.set(name, next);
            i++;
          }
        }
      }
      continue;
    }

    // Short flag: -f or -f value
    if (arg.startsWith("-") && arg.length === 2) {
      const name = arg.slice(1);
      if (booleanSet.has(name)) {
        flags.set(name, true);
      } else {
        const next = args[i + 1];
        if (next === undefined || next.startsWith("-")) {
          flags.set(name, true);
        } else {
          flags.set(name, next);
          i++;
        }
      }
      continue;
    }

    // Combined short flags: -abc (all boolean)
    if (arg.startsWith("-") && arg.length > 2 && !arg.startsWith("--")) {
      const chars = arg.slice(1);
      for (const ch of chars) {
        flags.set(ch, true);
      }
      continue;
    }

    // Positional argument
    positional.push(arg);
  }

  return {
    flags,
    positional,
    has(flag: string): boolean {
      return flags.has(flag);
    },
    get(flag: string): string | undefined {
      const val = flags.get(flag);
      if (val === true || val === undefined) return undefined;
      return val;
    },
  };
}
