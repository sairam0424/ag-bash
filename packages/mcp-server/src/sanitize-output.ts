/**
 * Output-content sanitization for LLM-facing tool results.
 *
 * ag-bash executes (untrusted) bash on behalf of an LLM agent and streams the
 * resulting stdout/stderr straight back into the model's context. Raw command
 * output is an injection surface: ANSI/OSC terminal escapes, C0/C1 control
 * bytes, zero-width characters, and Unicode bidi overrides (Trojan-Source) can
 * all smuggle instructions or hide content from a human reviewer while the
 * model still "sees" them. This module neutralizes those classes before the
 * text reaches the model.
 *
 * Design tension (read before editing): bash output is legitimately arbitrary
 * bytes, so we cannot escape or delete printable content without corrupting
 * real results. The conservative line we draw: strip only the *interpretable*
 * escape / control / invisible classes — a text-consuming LLM gains nothing
 * from a cursor-move or a zero-width joiner — and preserve every printable
 * character plus the three semantic whitespace bytes (\n \r \t). This keeps
 * false positives to "lost terminal colours / progress-bar animation", which
 * is an acceptable trade for a non-interactive, model-facing transport.
 *
 * Every invisible/bidi codepoint is written as an explicit `\uXXXX` escape so
 * the strip-list is auditable in source review and cannot be silently corrupted
 * by an editor (the chars are, by definition, invisible).
 *
 * It is intentionally dependency-free (the mcp-server bundles to a standalone
 * binary) and pure (no mutation of inputs), matching the package conventions.
 */

/** Default for the `sanitizeOutput` server option: on. */
export const SANITIZE_OUTPUT_DEFAULT = true;

/**
 * CSI sequences: ESC `[` … final-byte (`@`–`~`). Covers colours, cursor moves,
 * screen clears, and the like. The `0x40-0x7e` final-byte class is the VT100
 * spec range, so this matches malformed-but-interpreted sequences too.
 */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * OSC sequences: ESC `]` … terminated by BEL (`\x07`) or ST (ESC `\`).
 * These set window titles, hyperlinks, clipboard (OSC 52) — all high-risk for
 * a terminal a human might later view.
 */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Remaining single/two-char escapes: charset selects (`ESC ( B`), keypad modes,
 * and a bare/leftover `ESC`. Run AFTER CSI/OSC so we don't eat their leading
 * ESC first.
 */
const ESC_REMAINDER = /\x1b[@-Z\\-_]?/g;

/**
 * C0 (0x00–0x1F) and C1 (0x7F–0x9F) control characters, EXCEPT the three we
 * keep for legitimate text structure: TAB (0x09), LF (0x0A), CR (0x0D).
 */
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/**
 * Invisible / direction-overriding Unicode (written as explicit escapes):
 *  - U+200B–U+200D zero-width space / non-joiner / joiner
 *  - U+200E/U+200F LRM / RLM
 *  - U+202A–U+202E bidi embeddings & overrides (Trojan-Source)
 *  - U+2060 word joiner
 *  - U+2066–U+2069 bidi isolates
 *  - U+061C arabic letter mark
 *  - U+FEFF BOM / zero-width no-break space
 */
const INVISIBLE =
  /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\u061C\uFEFF]/g;

/**
 * Strip terminal-interpretable escapes, control bytes, and invisible/bidi
 * Unicode from text destined for an LLM. Order matters: OSC and CSI are removed
 * before the generic ESC pass so their leading ESC isn't consumed first.
 *
 * Pure: returns a new string, never mutates the input.
 *
 * @param text - Raw tool output (stdout/stderr/combined or a JSON rendering).
 * @returns The sanitized text, safe to embed in model context.
 */
export function sanitizeOutput(text: string): string {
  if (text.length === 0) return text;
  return text
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESC_REMAINDER, "")
    .replace(CONTROL, "")
    .replace(INVISIBLE, "");
}
