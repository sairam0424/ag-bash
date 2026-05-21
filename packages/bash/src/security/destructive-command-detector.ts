/**
 * Destructive Command Detector
 *
 * Static analysis module that scans shell command strings for patterns known to
 * cause irreversible or high-impact side effects (data loss, permission
 * escalation, infrastructure destruction).
 *
 * This is a PRE-EXECUTION defense layer. It runs before any command is handed to
 * the interpreter and returns a structured warning when a destructive pattern is
 * matched. The caller decides how to surface the warning (block, prompt, log).
 *
 * Design constraints:
 * - Zero external dependencies (pure RegExp matching)
 * - Returns the FIRST matching warning, checking critical severity before high
 * - Case-insensitive matching for SQL keywords; case-sensitive for everything else
 * - No false-negative guarantees — this is a best-effort heuristic layer
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DestructiveWarning {
  /** Broad category of the matched pattern. */
  category: "git" | "file" | "database" | "container" | "system";
  /** Human-readable description of what was matched. */
  pattern: string;
  /** Impact severity — critical patterns can cause total data loss. */
  severity: "high" | "critical";
}

// ---------------------------------------------------------------------------
// Internal pattern definitions
// ---------------------------------------------------------------------------

/**
 * A single detection rule. Rules are evaluated in declaration order within
 * their severity tier (critical first, then high).
 */
interface DetectionRule {
  category: DestructiveWarning["category"];
  severity: DestructiveWarning["severity"];
  pattern: string;
  test: (command: string) => boolean;
}

// -- Helpers ----------------------------------------------------------------

/**
 * Build a case-insensitive tester from a RegExp source string.
 * Used for SQL keywords that may appear in any casing.
 */
function caseInsensitive(source: string): (cmd: string) => boolean {
  const re = new RegExp(source, "i");
  return (cmd) => re.test(cmd);
}

/**
 * Build a case-sensitive tester from a RegExp source string.
 */
function caseSensitive(source: string): (cmd: string) => boolean {
  const re = new RegExp(source);
  return (cmd) => re.test(cmd);
}

// -- Critical rules (checked first) ----------------------------------------

const CRITICAL_RULES: DetectionRule[] = [
  // File — catastrophic rm targets (/, ~, *)
  {
    category: "file",
    severity: "critical",
    pattern: "may recursively force-remove critical files",
    test(command: string): boolean {
      if (!/\brm\b/.test(command)) return false;
      const afterRm = command.slice(command.search(/\brm\b/) + 2);
      const hasR = /-[^\s]*r/.test(afterRm) || /--recursive/.test(afterRm);
      const hasF = /-[^\s]*f/.test(afterRm) || /--force/.test(afterRm);
      if (!hasR || !hasF) return false;
      // Check for critical targets: /, ~, or bare *
      if (/(\s|^)(\/(\s|$|\*)|\*(\s|$)|~(\/|\s|$))/.test(afterRm)) return true;
      // Canonicalize paths containing .. to catch traversals like /tmp/../
      const pathArgs = afterRm.match(/(?:^|\s)(\/[^\s]+)/g);
      if (pathArgs) {
        for (const arg of pathArgs) {
          const p = arg.trim();
          if (/\.\./.test(p)) {
            const parts = p.split("/").filter(Boolean);
            const resolved: string[] = [];
            for (const seg of parts) {
              if (seg === "..") resolved.pop();
              else if (seg !== ".") resolved.push(seg);
            }
            const canonical = `/${resolved.join("/")}`;
            if (canonical === "/" || canonical === "") return true;
          }
        }
      }
      return false;
    },
  },

  // Database — DROP statements
  {
    category: "database",
    severity: "critical",
    pattern: "may drop database objects",
    test: caseInsensitive(String.raw`\bDROP\s+(TABLE|DATABASE|SCHEMA)\b`),
  },

  // System — format filesystem
  {
    category: "system",
    severity: "critical",
    pattern: "may format a filesystem",
    test: caseSensitive(String.raw`\bmkfs\b`),
  },

  // System — dd
  {
    category: "system",
    severity: "critical",
    pattern: "may overwrite disk data",
    test: caseSensitive(String.raw`\bdd\s+.*\bif=`),
  },

  // System — fork bomb
  {
    category: "system",
    severity: "critical",
    pattern: "fork bomb detected",
    test: caseSensitive(String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`),
  },
];

// -- High rules (checked second) -------------------------------------------

const HIGH_RULES: DetectionRule[] = [
  // Git — reset --hard
  {
    category: "git",
    severity: "high",
    pattern: "may discard uncommitted changes",
    test: caseSensitive(String.raw`\bgit\s+reset\s+--hard\b`),
  },

  // Git — push --force / push -f
  {
    category: "git",
    severity: "high",
    pattern: "may overwrite remote history",
    test: caseSensitive(String.raw`\bgit\s+push\s+.*(-f\b|--force\b)`),
  },

  // Git — clean -f (without -n / --dry-run)
  {
    category: "git",
    severity: "high",
    pattern: "may permanently delete untracked files",
    test(command: string): boolean {
      const cleanMatch = /\bgit\s+clean\s+(.*)/.exec(command);
      if (!cleanMatch) return false;
      const flags = cleanMatch[1];
      // If -n or --dry-run is present, this is safe
      if (/(-[^\s]*n|--dry-run)/.test(flags)) return false;
      // Must contain -f (possibly combined with other flags like -fd, -fx, -ffd)
      return /-[^\s]*f/.test(flags);
    },
  },

  // Git — checkout -- . / checkout .
  {
    category: "git",
    severity: "high",
    pattern: "may discard all working tree changes",
    test: caseSensitive(String.raw`\bgit\s+checkout\s+(--\s+\.|\.)\s*$`),
  },

  // Git — restore -- . / restore .
  {
    category: "git",
    severity: "high",
    pattern: "may discard all working tree changes",
    test: caseSensitive(String.raw`\bgit\s+restore\s+(--\s+\.|\.)\s*$`),
  },

  // Git — stash drop / stash clear
  {
    category: "git",
    severity: "high",
    pattern: "may permanently remove stashed changes",
    test: caseSensitive(String.raw`\bgit\s+stash\s+(drop|clear)\b`),
  },

  // Git — branch -D
  {
    category: "git",
    severity: "high",
    pattern: "may force-delete a branch",
    test: caseSensitive(String.raw`\bgit\s+branch\s+.*-D\b`),
  },

  // File — general rm -rf (after critical paths have been checked)
  {
    category: "file",
    severity: "high",
    pattern: "may recursively force-remove files",
    test: caseSensitive(
      String.raw`\brm\s+(-[^\s]*r[^\s]*\s+-[^\s]*f[^\s]*|-[^\s]*f[^\s]*\s+-[^\s]*r[^\s]*|-[^\s]*rf[^\s]*|-[^\s]*fr[^\s]*)\b`,
    ),
  },

  // File — chmod -R 777
  {
    category: "file",
    severity: "high",
    pattern: "may open all permissions recursively",
    test: caseSensitive(String.raw`\bchmod\s+(-R|--recursive)\s+777\b`),
  },

  // File — chown -R
  {
    category: "file",
    severity: "high",
    pattern: "may change ownership recursively",
    test: caseSensitive(String.raw`\bchown\s+(-R|--recursive)\b`),
  },

  // Database — TRUNCATE TABLE
  {
    category: "database",
    severity: "high",
    pattern: "may truncate database table",
    test: caseInsensitive(String.raw`\bTRUNCATE\s+TABLE\b`),
  },

  // Database — DELETE FROM without WHERE (or with WHERE 1=1)
  {
    category: "database",
    severity: "high",
    pattern: "may delete all rows",
    test(command: string): boolean {
      const deleteMatch = /\bDELETE\s+FROM\s+\S+/i.exec(command);
      if (!deleteMatch) return false;
      const afterDelete = command.slice(
        deleteMatch.index + deleteMatch[0].length,
      );
      // No WHERE clause at all
      if (!/\bWHERE\b/i.test(afterDelete)) return true;
      // WHERE 1=1 (tautology)
      if (/\bWHERE\s+1\s*=\s*1\b/i.test(afterDelete)) return true;
      return false;
    },
  },

  // Container — docker system prune
  {
    category: "container",
    severity: "high",
    pattern: "may remove all unused Docker resources",
    test: caseSensitive(String.raw`\bdocker\s+system\s+prune\b`),
  },

  // Container — docker rm -f $(docker ps ...)
  {
    category: "container",
    severity: "high",
    pattern: "may force-remove all containers",
    test: caseSensitive(String.raw`\bdocker\s+rm\s+.*-f.*\$\(docker\s+ps\b`),
  },
];

// -- Combined ordered list --------------------------------------------------

const ALL_RULES: DetectionRule[] = [...CRITICAL_RULES, ...HIGH_RULES];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a shell command string for destructive patterns.
 *
 * Returns the first matching {@link DestructiveWarning} (critical severity
 * patterns are checked before high severity patterns), or `null` if no
 * destructive pattern is detected.
 *
 * @param command - The raw command string to analyze.
 */
export function detectDestructiveCommand(
  command: string,
): DestructiveWarning | null {
  for (const rule of ALL_RULES) {
    if (rule.test(command)) {
      return {
        category: rule.category,
        pattern: rule.pattern,
        severity: rule.severity,
      };
    }
  }
  return null;
}
