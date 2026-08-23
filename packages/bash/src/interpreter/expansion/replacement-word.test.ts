import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

/**
 * Bash pattern substitution — `${v/pat/repl}` and friends.
 *
 * TWO HALVES, TWO DIFFERENT LANGUAGES:
 *  - The PATTERN half is glob-like and must be translated to a regex. A bracket
 *    expression has to keep matching as a bracket expression (see the
 *    "pattern half" block, which pins that).
 *  - The REPLACEMENT half is FULLY LITERAL. `$`, `$$`, `$&`, `` $` ``, `$'`,
 *    `$1`, `$<name>` have NO special meaning to bash — they are plain text.
 *    So neither Java nor `String.prototype.replace` replacement semantics is
 *    correct for it; the replacement must bypass `$`-interpretation entirely.
 *
 * Quote removal on the replacement word follows the DOUBLE-QUOTE rule: a
 * backslash is dropped only before `$`, `` ` ``, `"`, `\` and newline. Before
 * anything else — notably the glob metacharacters `*`, `?`, `[`, `]`, `.` — the
 * backslash is retained, because the replacement never goes through globbing so
 * there is nothing for it to escape.
 *
 * EVERY `expected` below was captured from `/bin/bash` (GNU bash 3.2.57) by
 * running the same script; none of them was derived from ag-bash's own output.
 */

interface SubstitutionCase {
  readonly name: string;
  readonly script: string;
  readonly expected: string;
}

async function stdoutOf(script: string): Promise<string> {
  const bash = new Bash();
  const result = await bash.exec(script);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

/** `v=abc`, then print one expansion (already double-quoted) with no newline. */
function scalar(expr: string): string {
  return `v=abc; printf "%s" "${expr}"`;
}

/** `a=(aXb cXd)`, then print each resulting word wrapped in `|...|`. */
function arrayWord(word: string): string {
  return `a=(aXb cXd); printf "|%s|" ${word}`;
}

/** `set -- aXb cXd`, then print each resulting word wrapped in `|...|`. */
function positionalWord(word: string): string {
  return `set -- aXb cXd; printf "|%s|" ${word}`;
}

function runCases(cases: readonly SubstitutionCase[]): void {
  it.each(cases)("$name", async ({ script, expected }) => {
    expect(await stdoutOf(script)).toBe(expected);
  });
}

describe("pattern substitution: quote removal on the replacement word", () => {
  runCases([
    {
      name: "drops the backslash before $ inside a bracket-shaped replacement",
      script: scalar("${v/b/[\\$Q]}"),
      expected: "a[$Q]c",
    },
    {
      name: "drops the backslash before $ even when a digit follows",
      script: scalar("${v/b/[\\$0]}"),
      expected: "a[$0]c",
    },
    {
      name: "drops the backslash before $ mid-bracket",
      script: scalar("${v/b/[A\\$B]}"),
      expected: "a[A$B]c",
    },
    {
      name: "collapses a doubled backslash inside a bracket-shaped replacement",
      script: scalar("${v/b/[A\\\\B]}"),
      expected: "a[A\\B]c",
    },
    {
      name: "KEEPS the backslash before * (replacement is never globbed)",
      script: scalar("${v/b/A\\*B}"),
      expected: "aA\\*Bc",
    },
    {
      name: "KEEPS the backslash before [",
      script: scalar("${v/b/A\\[B}"),
      expected: "aA\\[Bc",
    },
    {
      name: "KEEPS the backslash before .",
      script: scalar("${v/b/A\\.B}"),
      expected: "aA\\.Bc",
    },
    {
      name: "KEEPS the backslash before an ordinary character",
      script: scalar("${v/b/A\\_B}"),
      expected: "aA\\_Bc",
    },
    {
      name: "KEEPS the backslash before t (no C escapes here)",
      script: scalar("${v/b/A\\tB}"),
      expected: "aA\\tBc",
    },
    {
      name: "drops the backslash before $ in a plain replacement",
      script: scalar("${v/b/A\\$B}"),
      expected: "aA$Bc",
    },
    {
      name: "drops the backslash before a backtick",
      script: scalar("${v/b/A\\`B}"),
      expected: "aA`Bc",
    },
  ]);
});

describe("pattern substitution: the replacement is literal, not a regex replacement", () => {
  runCases([
    {
      name: "$$ is two literal dollars, not one escaped dollar",
      script: scalar("${v/b/\\$\\$}"),
      expected: "a$$c",
    },
    {
      name: "$& is literal, not the whole match",
      script: scalar("${v/b/\\$&}"),
      expected: "a$&c",
    },
    {
      name: "$1 is literal, not capture group 1",
      script: scalar("${v/b/\\$1}"),
      expected: "a$1c",
    },
    {
      name: "$` is literal, not the text before the match",
      script: scalar("${v/b/\\$\\`}"),
      expected: "a$`c",
    },
    {
      name: "$<name> is literal, not a named group",
      script: scalar("${v/b/\\$<name>}"),
      expected: "a$<name>c",
    },
    {
      name: "$12 is literal",
      script: scalar("${v/b/\\$12}"),
      expected: "a$12c",
    },
    {
      name: "$0 is literal",
      script: scalar("${v/b/\\$0}"),
      expected: "a$0c",
    },
  ]);
});

describe("pattern substitution: replacement text arriving from an expansion stays literal", () => {
  // These route the replacement text through `$r`, so quote removal is out of
  // the picture entirely and only the literal-replacement half is under test.
  runCases([
    {
      name: "$& from a variable",
      script: 'v=abc; r=\'$&\'; printf "%s" "${v/b/$r}"',
      expected: "a$&c",
    },
    {
      name: "$$ from a variable",
      script: 'v=abc; r=\'$$\'; printf "%s" "${v/b/$r}"',
      expected: "a$$c",
    },
    {
      name: "$1 from a variable",
      script: 'v=abc; r=\'$1\'; printf "%s" "${v/b/$r}"',
      expected: "a$1c",
    },
    {
      name: "$` from a variable",
      script: 'v=abc; r=\'$`\'; printf "%s" "${v/b/$r}"',
      expected: "a$`c",
    },
    {
      name: "$' from a variable",
      script: 'v=abc; r="\\$\'"; printf "%s" "${v/b/$r}"',
      expected: "a$'c",
    },
    {
      name: "$<n> from a variable",
      script: 'v=abc; r=\'$<n>\'; printf "%s" "${v/b/$r}"',
      expected: "a$<n>c",
    },
    {
      name: "$0 from a variable",
      script: 'v=abc; r=\'$0\'; printf "%s" "${v/b/$r}"',
      expected: "a$0c",
    },
    {
      name: "$12 from a variable",
      script: 'v=abc; r=\'$12\'; printf "%s" "${v/b/$r}"',
      expected: "a$12c",
    },
    {
      name: "two backslashes from a variable stay two backslashes",
      script: 'v=abc; r=\'\\\\\'; printf "%s" "${v/b/$r}"',
      expected: "a\\\\c",
    },
  ]);
});

describe("pattern substitution: the PATTERN half is still a glob", () => {
  // Guard rail. If the pattern were made literal alongside the replacement, a
  // bracket expression would stop matching its members and start matching its
  // own source text — `${v/[b]/Z}` would leave `abc` untouched instead of
  // producing `aZc`.
  runCases([
    {
      name: "a bracket expression matches its member, not its own text",
      script: scalar("${v/[b]/Z}"),
      expected: "aZc",
    },
    {
      name: "a multi-member bracket expression matches the first member",
      script: scalar("${v/[abc]/Z}"),
      expected: "Zbc",
    },
    {
      name: "a negated bracket expression still negates",
      script: scalar("${v/[!a]/Z}"),
      expected: "aZc",
    },
    {
      name: "? still matches any single character",
      script: scalar("${v/?/Z}"),
      expected: "Zbc",
    },
    {
      name: "* still matches greedily",
      script: scalar("${v/b*/Z}"),
      expected: "aZ",
    },
    {
      name: "glob pattern and literal replacement compose",
      script: scalar("${v/[b]/[\\$Q]}"),
      expected: "a[$Q]c",
    },
  ]);
});

describe("pattern substitution: global and anchored forms", () => {
  runCases([
    {
      name: "// applies quote removal to the replacement",
      script: scalar("${v//b/[\\$Q]}"),
      expected: "a[$Q]c",
    },
    {
      name: "// keeps $& literal",
      script: scalar("${v//b/\\$&}"),
      expected: "a$&c",
    },
    {
      name: "/# applies quote removal to the replacement",
      script: scalar("${v/#a/[\\$Q]}"),
      expected: "[$Q]bc",
    },
    {
      name: "/# keeps $& literal",
      script: scalar("${v/#a/\\$&}"),
      expected: "$&bc",
    },
    {
      name: "/% applies quote removal to the replacement",
      script: scalar("${v/%c/[\\$Q]}"),
      expected: "ab[$Q]",
    },
    {
      name: "/% keeps $& literal",
      script: scalar("${v/%c/\\$&}"),
      expected: "ab$&",
    },
    {
      name: "// keeps $& literal on every match",
      script: 'w=aXbXc; printf "%s" "${w//X/\\$&}"',
      expected: "a$&b$&c",
    },
    {
      name: "/ keeps $& literal on the first match only",
      script: 'w=aXbXc; printf "%s" "${w/X/\\$&}"',
      expected: "a$&bXc",
    },
  ]);
});

describe("pattern substitution: array forms", () => {
  runCases([
    {
      name: '"${a[@]//pat/repl}" applies quote removal',
      script: arrayWord('"${a[@]//X/[\\$Q]}"'),
      expected: "|a[$Q]b||c[$Q]d|",
    },
    {
      name: '"${a[@]/pat/repl}" applies quote removal',
      script: arrayWord('"${a[@]/X/[\\$Q]}"'),
      expected: "|a[$Q]b||c[$Q]d|",
    },
    {
      name: '"${a[@]//pat/repl}" keeps $& literal',
      script: arrayWord('"${a[@]//X/\\$&}"'),
      expected: "|a$&b||c$&d|",
    },
    {
      name: '"${a[@]/pat/repl}" keeps $& literal',
      script: arrayWord('"${a[@]/X/\\$&}"'),
      expected: "|a$&b||c$&d|",
    },
    {
      name: '"${a[*]//pat/repl}" keeps $& literal',
      script: arrayWord('"${a[*]//X/\\$&}"'),
      expected: "|a$&b c$&d|",
    },
    {
      name: "unquoted ${a[@]//pat/repl} keeps $& literal",
      script: arrayWord("${a[@]//X/\\$&}"),
      expected: "|a$&b||c$&d|",
    },
    {
      name: '"${a[@]/#pat/repl}" applies quote removal',
      script: arrayWord('"${a[@]/#a/[\\$Q]}"'),
      expected: "|[$Q]Xb||cXd|",
    },
    {
      name: '"${a[@]/%pat/repl}" keeps $& literal',
      script: arrayWord('"${a[@]/%b/\\$&}"'),
      expected: "|aX$&||cXd|",
    },
    {
      name: '"pre${a[@]//pat/repl}suf" keeps $& literal',
      script: arrayWord('"pre${a[@]//X/\\$&}suf"'),
      expected: "|prea$&b||c$&dsuf|",
    },
    {
      name: '"pre${a[@]//pat/repl}suf" applies quote removal',
      script: arrayWord('"pre${a[@]//X/[\\$Q]}suf"'),
      expected: "|prea[$Q]b||c[$Q]dsuf|",
    },
    {
      name: '"pre${a[@]/pat/repl}suf" keeps $& literal',
      script: arrayWord('"pre${a[@]/X/\\$&}suf"'),
      expected: "|prea$&b||c$&dsuf|",
    },
  ]);
});

describe("pattern substitution: positional parameter forms", () => {
  runCases([
    {
      name: '"${@//pat/repl}" applies quote removal',
      script: positionalWord('"${@//X/[\\$Q]}"'),
      expected: "|a[$Q]b||c[$Q]d|",
    },
    {
      name: '"${@//pat/repl}" keeps $& literal',
      script: positionalWord('"${@//X/\\$&}"'),
      expected: "|a$&b||c$&d|",
    },
    {
      name: '"${@/pat/repl}" keeps $& literal',
      script: positionalWord('"${@/X/\\$&}"'),
      expected: "|a$&b||c$&d|",
    },
    {
      name: '"${*//pat/repl}" keeps $& literal',
      script: positionalWord('"${*//X/\\$&}"'),
      expected: "|a$&b c$&d|",
    },
  ]);
});

describe("pattern substitution: replacements that need no unquoting", () => {
  runCases([
    {
      name: "an empty replacement deletes the match",
      script: scalar("${v/b/}"),
      expected: "ac",
    },
    {
      name: "a replacement containing the pattern is not re-matched",
      script: scalar("${v/b/b-b}"),
      expected: "ab-bc",
    },
    {
      name: "a doubled backslash collapses to one literal backslash",
      script: scalar("${v/b/x\\\\y}"),
      expected: "ax\\yc",
    },
  ]);
});
