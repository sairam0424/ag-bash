/**
 * GitTracker - Git operation audit and classification service.
 *
 * Classifies git commands into safe / mutating / destructive tiers,
 * maintains a bounded audit log, and publishes events to SharedStateBus.
 */

import type { SharedStateBus } from "./SharedStateBus.js";

export type GitClassification = "safe" | "mutating" | "destructive";

export interface GitOperation {
  id: string;
  command: string;
  classification: GitClassification;
  timestamp: number;
}

// ── Classification rules ────────────────────────────────────────────
// Order matters: destructive patterns are checked first so that a
// command like `git reset --hard` is not accidentally matched as
// mutating by a broader `git reset` rule.

interface ClassificationRule {
  test: (tokens: string[]) => boolean;
  classification: GitClassification;
}

/**
 * Tokenise a raw command string into lowercase tokens, collapsing
 * whitespace and stripping leading/trailing spaces.
 */
function tokenize(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map((t) => t.toLowerCase());
}

function hasToken(tokens: string[], value: string): boolean {
  return tokens.includes(value);
}

function hasAnyToken(tokens: string[], values: string[]): boolean {
  return values.some((v) => tokens.includes(v));
}

/**
 * Return the index of the first occurrence of `value` in `tokens`,
 * or -1 if absent.
 */
function tokenIndex(tokens: string[], value: string): number {
  return tokens.indexOf(value);
}

const DESTRUCTIVE_RULES: ClassificationRule[] = [
  // git reset --hard
  {
    test: (t) => hasToken(t, "reset") && hasToken(t, "--hard"),
    classification: "destructive",
  },
  // git push --force / -f
  {
    test: (t) =>
      hasToken(t, "push") &&
      hasAnyToken(t, ["--force", "-f", "--force-with-lease"]),
    classification: "destructive",
  },
  // git clean -f (any flag set containing f)
  {
    test: (t) => {
      if (!hasToken(t, "clean")) return false;
      return t.some((tok) => /^-[a-z]*f[a-z]*$/i.test(tok));
    },
    classification: "destructive",
  },
  // git checkout -- . (restore working tree)
  {
    test: (t) =>
      hasToken(t, "checkout") && hasToken(t, "--") && hasToken(t, "."),
    classification: "destructive",
  },
  // git restore -- . (restore working tree)
  {
    test: (t) =>
      hasToken(t, "restore") && hasToken(t, "--") && hasToken(t, "."),
    classification: "destructive",
  },
  // git branch -D / -d
  {
    test: (t) => {
      if (!hasToken(t, "branch")) return false;
      return t.some(
        (tok) => /^-[a-z]*[dD]$/.test(tok) || tok === "-d" || tok === "-D",
      );
    },
    classification: "destructive",
  },
  // git stash drop / clear
  {
    test: (t) => hasToken(t, "stash") && hasAnyToken(t, ["drop", "clear"]),
    classification: "destructive",
  },
  // git rebase -i (interactive)
  {
    test: (t) =>
      hasToken(t, "rebase") && hasAnyToken(t, ["-i", "--interactive"]),
    classification: "destructive",
  },
];

const SAFE_RULES: ClassificationRule[] = [
  // git log
  { test: (t) => hasToken(t, "log"), classification: "safe" },
  // git status
  { test: (t) => hasToken(t, "status"), classification: "safe" },
  // git diff
  { test: (t) => hasToken(t, "diff"), classification: "safe" },
  // git show
  { test: (t) => hasToken(t, "show"), classification: "safe" },
  // git branch (no args beyond flags like --list)
  {
    test: (t) => {
      const idx = tokenIndex(t, "branch");
      if (idx === -1) return false;
      // If the only tokens after "branch" are empty or list-style flags, it's safe
      const rest = t.slice(idx + 1);
      return (
        rest.length === 0 ||
        rest.every(
          (r) =>
            r === "--list" ||
            r === "-l" ||
            r === "-a" ||
            r === "--all" ||
            r === "-r" ||
            r === "--remotes",
        )
      );
    },
    classification: "safe",
  },
  // git remote -v
  {
    test: (t) => hasToken(t, "remote") && hasAnyToken(t, ["-v", "--verbose"]),
    classification: "safe",
  },
  // git tag -l / --list
  {
    test: (t) => hasToken(t, "tag") && hasAnyToken(t, ["-l", "--list"]),
    classification: "safe",
  },
  // git stash list
  {
    test: (t) => hasToken(t, "stash") && hasToken(t, "list"),
    classification: "safe",
  },
];

const MUTATING_RULES: ClassificationRule[] = [
  { test: (t) => hasToken(t, "add"), classification: "mutating" },
  { test: (t) => hasToken(t, "commit"), classification: "mutating" },
  { test: (t) => hasToken(t, "merge"), classification: "mutating" },
  { test: (t) => hasToken(t, "rebase"), classification: "mutating" },
  { test: (t) => hasToken(t, "cherry-pick"), classification: "mutating" },
  // git stash push / save (or bare git stash)
  {
    test: (t) => {
      if (!hasToken(t, "stash")) return false;
      const idx = tokenIndex(t, "stash");
      const sub = t[idx + 1];
      return sub === undefined || sub === "push" || sub === "save";
    },
    classification: "mutating",
  },
  { test: (t) => hasToken(t, "fetch"), classification: "mutating" },
  { test: (t) => hasToken(t, "pull"), classification: "mutating" },
  { test: (t) => hasToken(t, "push"), classification: "mutating" },
  // git tag (create) — any `git tag` that isn't list
  { test: (t) => hasToken(t, "tag"), classification: "mutating" },
  // git reset (without --hard is mutating)
  { test: (t) => hasToken(t, "reset"), classification: "mutating" },
  // git checkout (without -- .) is mutating
  { test: (t) => hasToken(t, "checkout"), classification: "mutating" },
  // git restore (without -- .) is mutating
  { test: (t) => hasToken(t, "restore"), classification: "mutating" },
  // git branch with create/delete flags already handled above
  { test: (t) => hasToken(t, "branch"), classification: "mutating" },
  // git clean without -f
  { test: (t) => hasToken(t, "clean"), classification: "mutating" },
];

// ── ID generation ───────────────────────────────────────────────────

// ── Service ─────────────────────────────────────────────────────────

const MAX_LOG_SIZE = 500;

export class GitTracker {
  private log: GitOperation[] = [];
  private nextOpId = 1;
  private bus: SharedStateBus | undefined;

  setBus(bus: SharedStateBus): void {
    this.bus = bus;
  }

  /**
   * Classify a raw git command string without recording it.
   *
   * The command may optionally start with "git " — the classifier
   * strips the leading "git" token before matching sub-commands.
   */
  classifyCommand(command: string): GitClassification {
    const tokens = tokenize(command);

    // Strip a leading "git" so callers can pass full commands.
    if (tokens[0] === "git") {
      tokens.shift();
    }

    if (tokens.length === 0) {
      return "safe";
    }

    // Destructive first — highest priority.
    for (const rule of DESTRUCTIVE_RULES) {
      if (rule.test(tokens)) return rule.classification;
    }

    // Safe second — explicit read-only commands.
    for (const rule of SAFE_RULES) {
      if (rule.test(tokens)) return rule.classification;
    }

    // Mutating third — write operations that are recoverable.
    for (const rule of MUTATING_RULES) {
      if (rule.test(tokens)) return rule.classification;
    }

    // Unknown git sub-commands default to safe (read-only assumption).
    return "safe";
  }

  /**
   * Classify, record, and publish a git operation.
   * Returns the created audit entry.
   */
  recordOperation(command: string): GitOperation {
    const classification = this.classifyCommand(command);
    const op: GitOperation = {
      id: `gitop_${this.nextOpId++}`,
      command,
      classification,
      timestamp: Date.now(),
    };

    this.log.push(op);

    // Enforce bounded log size — drop oldest entries.
    if (this.log.length > MAX_LOG_SIZE) {
      this.log = this.log.slice(this.log.length - MAX_LOG_SIZE);
    }

    this.bus?.publish("git:operation", "gitTracker", { ...op });

    return op;
  }

  /** Return the full audit log (defensive copy). */
  getLog(): GitOperation[] {
    return this.log.map((op) => ({ ...op }));
  }

  /** Return only destructive operations from the audit log. */
  getDestructiveOps(): GitOperation[] {
    return this.log
      .filter((op) => op.classification === "destructive")
      .map((op) => ({ ...op }));
  }
}
