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

// The AST shapes the AST-based detector walks (types only — zero runtime coupling).
import type {
  CommandNode,
  CommandSubstitutionPart,
  PipelineNode,
  ScriptNode,
  StatementNode,
  WordNode,
  WordPart,
} from "../ast/types.js";

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
  // biome-ignore lint/style/noRestrictedGlobals: internal controlled detection pattern (not user input); native RegExp is the documented choice for these
  const re = new RegExp(source, "i");
  return (cmd) => re.test(cmd);
}

/**
 * Build a case-sensitive tester from a RegExp source string.
 */
function caseSensitive(source: string): (cmd: string) => boolean {
  // biome-ignore lint/style/noRestrictedGlobals: internal controlled detection pattern (not user input); native RegExp is the documented choice for these
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

// ===========================================================================
// AST-based destructive detection (E2)
// ===========================================================================
//
// The regex detector above scans the FLAT command string and is therefore
// fooled by obfuscation (`echo "rm -rf /"` looks dangerous, `rm -rf $(echo /)`
// looks safe). The AST-based detector below walks the PARSED tree so that:
//   - A dangerous string that is merely an `echo`/`grep` ARGUMENT is in a
//     different structural position than an executed `rm` command's target,
//     so it is NOT flagged.
//   - Obfuscations that hide the target behind a command substitution
//     (`rm -rf $(echo /)`) or IFS expansion (`rm -rf $IFS/`, `rm -rf ${IFS}`)
//     ARE flagged structurally, because the analyzer inspects the WordPart
//     shape of each argument rather than its expanded text.
//
// This detector is consumed by the live ExecutionPipeline's DestructiveStage.
// The regex `detectDestructiveCommand` above is retained unchanged for the
// advisory MCP tool path.

/**
 * A destructive finding produced by the AST analyzer. Mirrors
 * {@link DestructiveWarning} but adds the offending command name and a stable
 * machine-readable code for typed agent consumption.
 */
export interface DestructiveAstFinding {
  category: DestructiveWarning["category"];
  /** Human-readable description of what was matched. */
  pattern: string;
  severity: DestructiveWarning["severity"];
  /** The resolved command name responsible for the finding (e.g. "rm"). */
  command: string;
  /** Stable machine code (e.g. "DESTRUCTIVE_RM_ROOT", "FORK_BOMB"). */
  code: string;
}

/**
 * A structural, expansion-aware view of a single argument word.
 * Built once per word so detection rules can reason about both the literal
 * text AND whether the word smuggles in a command substitution / IFS
 * expansion / glob — the things that defeat flat-string regex matching.
 */
interface ArgShape {
  /**
   * The concatenated LITERAL/quoted text of the word (expansions contribute an
   * empty string). Used for plain target matching like "/" or "/dev/sda".
   */
  literal: string;
  /** Word contains a $(...) or `...` command substitution. */
  hasCommandSubstitution: boolean;
  /** Word references $IFS or ${IFS} (classic whitespace-obfuscation). */
  hasIfsExpansion: boolean;
  /** Word contains any parameter expansion ($VAR / ${VAR}). */
  hasParameterExpansion: boolean;
  /** Word contains an unquoted glob (`*`, `?`, `[`). */
  hasGlob: boolean;
}

/**
 * Flatten a word's parts into an {@link ArgShape}. Walks nested double-quoted
 * parts so quoting does not hide expansions.
 */
function shapeOfWord(word: WordNode): ArgShape {
  const shape: ArgShape = {
    literal: "",
    hasCommandSubstitution: false,
    hasIfsExpansion: false,
    hasParameterExpansion: false,
    hasGlob: false,
  };
  collectPartShape(word.parts, shape);
  return shape;
}

function collectPartShape(parts: WordPart[], shape: ArgShape): void {
  for (const part of parts) {
    switch (part.type) {
      case "Literal":
        shape.literal += part.value;
        break;
      case "SingleQuoted":
        shape.literal += part.value;
        break;
      case "DoubleQuoted":
        collectPartShape(part.parts, shape);
        break;
      case "Escaped":
        shape.literal += part.value;
        break;
      case "CommandSubstitution":
        shape.hasCommandSubstitution = true;
        break;
      case "ParameterExpansion":
        shape.hasParameterExpansion = true;
        if (part.parameter === "IFS") {
          shape.hasIfsExpansion = true;
        }
        break;
      case "Glob":
        shape.hasGlob = true;
        shape.literal += part.pattern;
        break;
      default:
        // ArithmeticExpansion / ProcessSubstitution / BraceExpansion /
        // TildeExpansion — none contribute stable literal text we match on.
        break;
    }
  }
}

/** Resolve a command name word to its literal text (expansions → ""). */
function resolveName(name: WordNode | null): string {
  if (!name) return "";
  const shape: ArgShape = {
    literal: "",
    hasCommandSubstitution: false,
    hasIfsExpansion: false,
    hasParameterExpansion: false,
    hasGlob: false,
  };
  collectPartShape(name.parts, shape);
  return shape.literal;
}

/**
 * A normalized view of a single simple command: its name plus the structural
 * shapes of all of its arguments. Detection rules consume this.
 */
interface CommandView {
  name: string;
  args: ArgShape[];
}

// -- Per-command destructive checks ----------------------------------------

/** Does the argv (post-name) contain both a recursive and a force flag? */
function hasRecursiveForce(args: ArgShape[]): boolean {
  let recursive = false;
  let force = false;
  for (const arg of args) {
    const text = arg.literal;
    if (text === "--recursive") recursive = true;
    if (text === "--force") force = true;
    // Short flag clusters: -rf, -fr, -r, -f, -Rf, etc.
    if (text.length >= 2 && text[0] === "-" && text[1] !== "-") {
      const cluster = text.slice(1);
      if (cluster.includes("r") || cluster.includes("R")) recursive = true;
      if (cluster.includes("f")) force = true;
    }
  }
  return recursive && force;
}

/**
 * Is this rm target word catastrophic? Catches plain "/", "~", bare "*",
 * AND obfuscated forms: command substitution ($(echo /)) and IFS expansion
 * ($IFS/) which structurally smuggle a root-ish target past flat regex.
 */
function isCatastrophicRmTarget(arg: ArgShape): boolean {
  const t = arg.literal;
  // Plain catastrophic literals.
  if (t === "/" || t === "~" || t === "/*" || t === "~/") return true;
  if (arg.hasGlob && (t === "*" || t === "/*")) return true;
  // IFS-expansion obfuscation: `rm -rf $IFS/` → word has IFS expansion plus a
  // leading-slash literal, or `rm -rf ${IFS}` alone.
  if (arg.hasIfsExpansion) return true;
  // Command-substitution obfuscation: `rm -rf $(echo /)` — the target is
  // produced by a subshell. Treat a recursive-force rm whose target is a bare
  // command substitution as catastrophic (we cannot prove it is safe).
  if (arg.hasCommandSubstitution && t === "") return true;
  return false;
}

/** Detect a destructive rm. */
function checkRm(view: CommandView): DestructiveAstFinding | null {
  if (view.name !== "rm") return null;
  const flagless = view.args.filter((a) => !a.literal.startsWith("-"));
  if (!hasRecursiveForce(view.args)) return null;
  for (const target of flagless) {
    if (isCatastrophicRmTarget(target)) {
      return {
        category: "file",
        pattern: "recursively force-removes a catastrophic target",
        severity: "critical",
        command: "rm",
        code: "DESTRUCTIVE_RM_ROOT",
      };
    }
  }
  return null;
}

/** Detect dd writing to a block/raw device. */
function checkDd(view: CommandView): DestructiveAstFinding | null {
  if (view.name !== "dd") return null;
  for (const arg of view.args) {
    const t = arg.literal;
    if (t.startsWith("of=")) {
      const target = t.slice(3);
      if (target.startsWith("/dev/")) {
        return {
          category: "system",
          pattern: "overwrites a raw disk device",
          severity: "critical",
          command: "dd",
          code: "DESTRUCTIVE_DD_DEVICE",
        };
      }
    }
  }
  return null;
}

/** Detect mkfs.* (filesystem format). */
function checkMkfs(view: CommandView): DestructiveAstFinding | null {
  if (view.name === "mkfs" || view.name.startsWith("mkfs.")) {
    return {
      category: "system",
      pattern: "formats a filesystem",
      severity: "critical",
      command: view.name,
      code: "DESTRUCTIVE_MKFS",
    };
  }
  return null;
}

/** Names that execute their stdin as a shell program. */
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Names that decode/transform opaque payloads typically piped into a shell. */
const DECODER_NAMES = new Set(["base64", "xxd", "openssl", "uudecode"]);

// -- AST walking ------------------------------------------------------------

/** Walk a script, collecting every SimpleCommand as a CommandView. */
function collectCommandViews(script: ScriptNode): CommandView[] {
  const views: CommandView[] = [];
  for (const statement of script.statements) {
    collectFromStatement(statement, views);
  }
  return views;
}

function collectFromStatement(
  statement: StatementNode,
  views: CommandView[],
): void {
  for (const pipeline of statement.pipelines) {
    collectFromPipeline(pipeline, views);
  }
}

function collectFromPipeline(
  pipeline: PipelineNode,
  views: CommandView[],
): void {
  for (const command of pipeline.commands) {
    collectFromCommand(command, views);
  }
}

function collectFromCommand(command: CommandNode, views: CommandView[]): void {
  switch (command.type) {
    case "SimpleCommand": {
      const args = command.args.map(shapeOfWord);
      views.push({ name: resolveName(command.name), args });
      // Descend into command substitutions nested in name/args so that
      // `rm -rf $(echo /)` also analyzes the inner `echo /` (harmless) AND
      // any genuinely dangerous inner command.
      const allWords: WordNode[] = command.name
        ? [command.name, ...command.args]
        : [...command.args];
      for (const word of allWords) {
        for (const sub of commandSubstitutionsOf(word)) {
          for (const stmt of sub.body.statements) {
            collectFromStatement(stmt, views);
          }
        }
      }
      break;
    }
    case "FunctionDef":
      collectFromCompound(command.body, views);
      break;
    default:
      collectFromCompound(command, views);
      break;
  }
}

/** Pull command substitution parts out of a word (incl. inside double quotes). */
function commandSubstitutionsOf(word: WordNode): CommandSubstitutionPart[] {
  const out: CommandSubstitutionPart[] = [];
  collectSubs(word.parts, out);
  return out;
}

function collectSubs(parts: WordPart[], out: CommandSubstitutionPart[]): void {
  for (const part of parts) {
    if (part.type === "CommandSubstitution") {
      out.push(part);
    } else if (part.type === "DoubleQuoted") {
      collectSubs(part.parts, out);
    }
  }
}

/** Recurse into compound commands, gathering their inner statements. */
function collectFromCompound(
  // biome-ignore lint/suspicious/noExplicitAny: structural walk over the wide
  // CompoundCommandNode union; field access is guarded by presence checks.
  node: any,
  views: CommandView[],
): void {
  const bodies: StatementNode[][] = [];
  if (Array.isArray(node.body)) bodies.push(node.body);
  if (Array.isArray(node.clauses)) {
    for (const clause of node.clauses) {
      if (Array.isArray(clause.condition)) bodies.push(clause.condition);
      if (Array.isArray(clause.body)) bodies.push(clause.body);
    }
  }
  if (Array.isArray(node.elseBody)) bodies.push(node.elseBody);
  if (Array.isArray(node.condition)) bodies.push(node.condition);
  if (Array.isArray(node.items)) {
    for (const item of node.items) {
      if (Array.isArray(item.body)) bodies.push(item.body);
    }
  }
  for (const body of bodies) {
    for (const statement of body) {
      collectFromStatement(statement, views);
    }
  }
}

/**
 * Detect a decode-pipe-to-shell pipeline: `<decoder> ... | sh`. Operates on
 * the pipeline structure so the shell interpreter must be the SINK of a pipe
 * fed by a decoder — `echo "base64 | sh"` (a quoted echo arg) is NOT a pipe
 * and is therefore not flagged.
 */
function checkDecodePipeToShell(
  pipeline: PipelineNode,
): DestructiveAstFinding | null {
  if (pipeline.commands.length < 2) return null;
  const names = pipeline.commands.map((cmd) =>
    cmd.type === "SimpleCommand" ? resolveName(cmd.name) : "",
  );
  const sink = names[names.length - 1];
  if (!SHELL_INTERPRETERS.has(sink)) return null;
  // Any upstream command that is a decoder makes this a decode-pipe-to-shell.
  for (let i = 0; i < names.length - 1; i++) {
    if (DECODER_NAMES.has(names[i])) {
      return {
        category: "system",
        pattern: "decodes an opaque payload and pipes it to a shell",
        severity: "critical",
        command: `${names[i]} | ${sink}`,
        code: "DESTRUCTIVE_DECODE_PIPE_SHELL",
      };
    }
  }
  return null;
}

/** Walk all pipelines (incl. nested) running the pipe-shape check. */
function collectPipelineFindings(script: ScriptNode): DestructiveAstFinding[] {
  const findings: DestructiveAstFinding[] = [];
  const walkStatement = (statement: StatementNode): void => {
    for (const pipeline of statement.pipelines) {
      const finding = checkDecodePipeToShell(pipeline);
      if (finding) findings.push(finding);
      for (const command of pipeline.commands) {
        for (const sub of nestedScripts(command)) {
          for (const stmt of sub.statements) walkStatement(stmt);
        }
      }
    }
  };
  for (const statement of script.statements) walkStatement(statement);
  return findings;
}

/** Inner scripts reachable from a command (command substitutions + compounds). */
function nestedScripts(command: CommandNode): ScriptNode[] {
  const out: ScriptNode[] = [];
  if (command.type === "SimpleCommand") {
    const words = command.name
      ? [command.name, ...command.args]
      : [...command.args];
    for (const word of words) {
      for (const sub of commandSubstitutionsOf(word)) out.push(sub.body);
    }
  }
  return out;
}

/**
 * Detect a fork bomb structurally: a function definition `:` whose body
 * recursively pipes itself into a backgrounded copy and is then invoked.
 * Source form: `:(){ :|:& };:`.
 *
 * Recursive-descent parsers represent this differently from a clean function
 * definition, so we accept either signal: a FunctionDef named ":" whose body
 * pipes ":" into ":", OR the raw text fallback (the parser may not produce a
 * tidy FunctionDef for the dense one-liner). The raw-text guard here is a
 * structural backstop, NOT the primary mechanism.
 */
function checkForkBomb(
  script: ScriptNode,
  rawScript: string,
): DestructiveAstFinding | null {
  // Structural: a function named ":" that references ":" in a backgrounded
  // pipeline within its own body.
  for (const statement of script.statements) {
    for (const pipeline of statement.pipelines) {
      for (const command of pipeline.commands) {
        if (command.type === "FunctionDef" && command.name === ":") {
          return {
            category: "system",
            pattern: "fork bomb (self-replicating function)",
            severity: "critical",
            command: ":",
            code: "FORK_BOMB",
          };
        }
      }
    }
  }
  // Structural backstop for the dense one-liner the recursive-descent parser
  // may not fold into a FunctionDef node.
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;\s*:/.test(rawScript)) {
    return {
      category: "system",
      pattern: "fork bomb (self-replicating function)",
      severity: "critical",
      command: ":",
      code: "FORK_BOMB",
    };
  }
  return null;
}

/**
 * Analyze a PARSED bash AST for destructive commands.
 *
 * This is the structural counterpart to {@link detectDestructiveCommand}. It
 * walks the tree — simple commands, their argument WordPart shapes, command
 * substitutions, compound bodies, and pipeline structure — so that:
 *   - obfuscated targets (command substitution, IFS expansion) ARE caught;
 *   - dangerous strings sitting in an `echo`/`grep` ARGUMENT are NOT caught.
 *
 * Returns the FIRST finding (all current findings are critical), or null.
 *
 * @param ast - The parsed script AST.
 * @param rawScript - The original source text, used ONLY as a structural
 *   backstop for the dense fork-bomb one-liner. Never used for path matching.
 */
export function analyzeDestructiveAst(
  ast: ScriptNode,
  rawScript = "",
): DestructiveAstFinding | null {
  // Fork bomb first (whole-script structural signal).
  const forkBomb = checkForkBomb(ast, rawScript);
  if (forkBomb) return forkBomb;

  // Pipeline-shape findings (decode-pipe-to-shell).
  const pipelineFindings = collectPipelineFindings(ast);
  if (pipelineFindings.length > 0) return pipelineFindings[0];

  // Per-command findings.
  const views = collectCommandViews(ast);
  for (const view of views) {
    const finding = checkRm(view) ?? checkDd(view) ?? checkMkfs(view);
    if (finding) return finding;
  }
  return null;
}
