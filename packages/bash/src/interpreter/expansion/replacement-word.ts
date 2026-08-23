/**
 * The REPLACEMENT half of bash pattern substitution.
 *
 * `${v/pattern/replacement}` is two different languages glued together by a
 * slash. The PATTERN half is glob-like and is translated to a regex (see
 * `patternToRegex`). The REPLACEMENT half is FULLY LITERAL: `$`, `$$`, `$&`,
 * `` $` ``, `$'`, `$1` and `$<name>` carry no meaning for bash, they are plain
 * text. This module owns the two consequences of that, so all five call sites
 * (scalar, array, array-with-adjacent-text, positional, unquoted) agree.
 */

import type { WordNode, WordPart } from "../../ast/types.js";
import type { RegexLike } from "../../regex/index.js";
import type { InterpreterContext } from "../types.js";
import type { ExpandPartFn } from "./parameter-ops.js";

/**
 * Characters whose backslash bash removes inside a pattern-substitution
 * replacement word — the same set as inside double quotes.
 *
 * Verified against GNU bash 3.2.57 with `v=abc`:
 *   `${v/b/A\$B}`  -> `aA$Bc`    backslash dropped
 *   `${v/b/A\`B}`  -> "aA`Bc"    backslash dropped
 *   `${v/b/A\\B}`  -> `aA\Bc`    backslash dropped
 *   `${v/b/A\*B}`  -> `aA\*Bc`   backslash KEPT
 *   `${v/b/A\[B}`  -> `aA\[Bc`   backslash KEPT
 *   `${v/b/A\.B}`  -> `aA\.Bc`   backslash KEPT
 *   `${v/b/A\_B}`  -> `aA\_Bc`   backslash KEPT
 * The glob metacharacters keep their backslash because the replacement is never
 * globbed, so there is nothing there for a backslash to escape.
 */
const DOUBLE_QUOTE_ESCAPABLE = '$`"\\\n';

/**
 * Apply replacement-word quote removal to already-expanded text: drop a
 * backslash only when it quotes one of `DOUBLE_QUOTE_ESCAPABLE`.
 */
function removeReplacementQuoting(text: string): string {
  if (!text.includes("\\")) {
    return text;
  }
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (
      char === "\\" &&
      next !== undefined &&
      DOUBLE_QUOTE_ESCAPABLE.includes(next)
    ) {
      result += next;
      i++;
      continue;
    }
    result += char;
  }
  return result;
}

/**
 * Expand a pattern-substitution replacement word to its final literal text.
 *
 * Two part types need replacement-specific treatment, because the generic word
 * expansion path serves globbing, where the surviving backslashes are load
 * bearing:
 *
 *  - `Glob` (`[\$Q]`, `A\*B` when the lexer folded it into a bracket token) is
 *    handed through as raw source text so the glob engine can read the escapes.
 *    In a replacement there is no glob engine, so the escapes have to be
 *    resolved here. This is the half that `re2js`'s legacy Java replacement mode
 *    used to hide, by eating the backslash on its way through the replacer.
 *  - `Escaped` is the lexer's node for `\X` where X is a glob metacharacter; it
 *    carries only X, having dropped the backslash. Bash keeps that backslash for
 *    every X except `DOUBLE_QUOTE_ESCAPABLE`, so it is restored here.
 *
 * Everything else (`Literal`, `SingleQuoted`, `DoubleQuoted`, parameter and
 * command substitution, ...) is already correct: the lexer resolved its quoting,
 * or the value came from an expansion and must be used verbatim.
 */
export async function expandReplacementWord(
  ctx: InterpreterContext,
  word: WordNode | null | undefined,
  expandPart: ExpandPartFn,
): Promise<string> {
  if (!word) {
    return "";
  }
  const pieces: string[] = [];
  for (const part of word.parts) {
    pieces.push(await expandReplacementPart(ctx, part, expandPart));
  }
  return pieces.join("");
}

async function expandReplacementPart(
  ctx: InterpreterContext,
  part: WordPart,
  expandPart: ExpandPartFn,
): Promise<string> {
  if (part.type === "Escaped") {
    return DOUBLE_QUOTE_ESCAPABLE.includes(part.value)
      ? part.value
      : `\\${part.value}`;
  }
  if (part.type === "Glob") {
    // expandPart resolves `$var` inside the pattern while leaving `\X` pairs
    // intact, which is exactly the input removeReplacementQuoting wants.
    return removeReplacementQuoting(await expandPart(ctx, part));
  }
  return expandPart(ctx, part);
}

/**
 * Substitute `replacement` for matches of `re` in `input`, treating the
 * replacement as literal text.
 *
 * `RegexLike.replace` with a STRING replacement follows
 * `String.prototype.replace` semantics, where `$$`, `$&`, `` $` ``, `$'`, `$1`
 * and `$<name>` are all special. `user-regex.ts` exposes no literal-replacement
 * entry point, so this goes through the CALLBACK form instead of escaping the
 * dollars: a callback's return value is spliced in verbatim and is never
 * re-scanned, which makes the bypass total rather than dependent on knowing the
 * full catalogue of special sequences.
 */
export function replaceLiteral(
  re: RegexLike,
  input: string,
  replacement: string,
): string {
  return re.replace(input, () => replacement);
}
