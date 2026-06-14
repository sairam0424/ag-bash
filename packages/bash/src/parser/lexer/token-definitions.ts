/**
 * Token Definitions for the Bash Lexer
 *
 * Contains all type definitions, enums, constants, and utility functions
 * used by the lexer's tokenization logic.
 */

// Default max heredoc size to prevent memory exhaustion (10MB)
export const DEFAULT_MAX_HEREDOC_SIZE = 10_485_760;

export interface LexerOptions {
  /** Maximum heredoc size in bytes (default: 10MB) */
  maxHeredocSize?: number;
}

export enum TokenType {
  // End of input
  EOF = "EOF",

  // Newlines and separators
  NEWLINE = "NEWLINE",
  SEMICOLON = "SEMICOLON",
  AMP = "AMP", // &

  // Operators
  PIPE = "PIPE", // |
  PIPE_AMP = "PIPE_AMP", // |&
  AND_AND = "AND_AND", // &&
  OR_OR = "OR_OR", // ||
  BANG = "BANG", // !

  // Redirections
  LESS = "LESS", // <
  GREAT = "GREAT", // >
  DLESS = "DLESS", // <<
  DGREAT = "DGREAT", // >>
  LESSAND = "LESSAND", // <&
  GREATAND = "GREATAND", // >&
  LESSGREAT = "LESSGREAT", // <>
  DLESSDASH = "DLESSDASH", // <<-
  CLOBBER = "CLOBBER", // >|
  TLESS = "TLESS", // <<<
  AND_GREAT = "AND_GREAT", // &>
  AND_DGREAT = "AND_DGREAT", // &>>

  // Grouping
  LPAREN = "LPAREN", // (
  RPAREN = "RPAREN", // )
  LBRACE = "LBRACE", // {
  RBRACE = "RBRACE", // }

  // Special
  DSEMI = "DSEMI", // ;;
  SEMI_AND = "SEMI_AND", // ;&
  SEMI_SEMI_AND = "SEMI_SEMI_AND", // ;;&

  // Compound commands
  DBRACK_START = "DBRACK_START", // [[
  DBRACK_END = "DBRACK_END", // ]]
  DPAREN_START = "DPAREN_START", // ((
  DPAREN_END = "DPAREN_END", // ))

  // Reserved words
  IF = "IF",
  THEN = "THEN",
  ELSE = "ELSE",
  ELIF = "ELIF",
  FI = "FI",
  FOR = "FOR",
  WHILE = "WHILE",
  UNTIL = "UNTIL",
  DO = "DO",
  DONE = "DONE",
  CASE = "CASE",
  ESAC = "ESAC",
  IN = "IN",
  FUNCTION = "FUNCTION",
  SELECT = "SELECT",
  TIME = "TIME",
  COPROC = "COPROC",

  // Words and identifiers
  WORD = "WORD",
  NAME = "NAME", // Valid variable name
  NUMBER = "NUMBER", // For redirections like 2>&1
  ASSIGNMENT_WORD = "ASSIGNMENT_WORD", // VAR=value
  FD_VARIABLE = "FD_VARIABLE", // {varname} before redirect operator

  // Comments
  COMMENT = "COMMENT",

  // Here-document content
  HEREDOC_CONTENT = "HEREDOC_CONTENT",
}

export interface Token {
  type: TokenType;
  value: string;
  /** Original position in input */
  start: number;
  end: number;
  line: number;
  column: number;
  /** For WORD tokens: quote information */
  quoted?: boolean;
  singleQuoted?: boolean;
}

/**
 * Error thrown when the lexer encounters invalid input
 */
export class LexerError extends Error {
  constructor(
    message: string,
    public line: number,
    public column: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = "LexerError";
  }
}

/**
 * Reserved words in bash
 * Using Map to prevent prototype pollution (e.g., "constructor", "__proto__")
 */
export const RESERVED_WORDS: Map<string, TokenType> = new Map<
  string,
  TokenType
>([
  ["if", TokenType.IF],
  ["then", TokenType.THEN],
  ["else", TokenType.ELSE],
  ["elif", TokenType.ELIF],
  ["fi", TokenType.FI],
  ["for", TokenType.FOR],
  ["while", TokenType.WHILE],
  ["until", TokenType.UNTIL],
  ["do", TokenType.DO],
  ["done", TokenType.DONE],
  ["case", TokenType.CASE],
  ["esac", TokenType.ESAC],
  ["in", TokenType.IN],
  ["function", TokenType.FUNCTION],
  ["select", TokenType.SELECT],
  ["time", TokenType.TIME],
  ["coproc", TokenType.COPROC],
]);

/**
 * Check if a string is a valid assignment LHS with optional nested array subscript
 * Handles: VAR, a[0], a[x], a[a[0]], a[x+1], etc.
 */
export function isValidAssignmentLHS(str: string): boolean {
  // Must start with valid variable name
  const match = str.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
  if (!match) return false;

  const afterName = str.slice(match[0].length);

  // If nothing after name, it's valid (simple variable)
  if (afterName === "" || afterName === "+") return true;

  // If it's an array subscript, need to check for balanced brackets
  if (afterName[0] === "[") {
    // Find matching close bracket (handling nested brackets)
    let depth = 0;
    let i = 0;
    for (; i < afterName.length; i++) {
      if (afterName[i] === "[") depth++;
      else if (afterName[i] === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    // Must have found closing bracket
    if (depth !== 0 || i >= afterName.length) return false;
    // After closing bracket, only + is allowed (for +=)
    const afterBracket = afterName.slice(i + 1);
    return afterBracket === "" || afterBracket === "+";
  }

  return false;
}

/**
 * Find the index of assignment '=' or '+=' outside of brackets.
 * Returns the index of '=' (or '=' after '+') or -1 if not found.
 * For 'a[x=1]=value', returns the index of the second '='.
 */
export function findAssignmentEq(str: string): number {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "[") {
      depth++;
    } else if (c === "]") {
      depth--;
    } else if (depth === 0 && c === "=") {
      return i;
    } else if (depth === 0 && c === "+" && str[i + 1] === "=") {
      return i + 1; // Return position of '=' in '+='
    }
  }
  return -1;
}

/**
 * Three-character operators (simple ones without special handling)
 */
export const THREE_CHAR_OPS: Array<[string, string, string, TokenType]> = [
  [";", ";", "&", TokenType.SEMI_SEMI_AND],
  ["<", "<", "<", TokenType.TLESS],
  ["&", ">", ">", TokenType.AND_DGREAT],
  // Note: <<- has special handling for heredoc, not included here
];

/**
 * Two-character operators (simple ones without special handling)
 * Note: << has special handling for heredoc, not included here
 */
export const TWO_CHAR_OPS: Array<[string, string, TokenType]> = [
  ["[", "[", TokenType.DBRACK_START],
  ["]", "]", TokenType.DBRACK_END],
  ["(", "(", TokenType.DPAREN_START],
  [")", ")", TokenType.DPAREN_END],
  ["&", "&", TokenType.AND_AND],
  ["|", "|", TokenType.OR_OR],
  [";", ";", TokenType.DSEMI],
  [";", "&", TokenType.SEMI_AND],
  ["|", "&", TokenType.PIPE_AMP],
  [">", ">", TokenType.DGREAT],
  ["<", "&", TokenType.LESSAND],
  [">", "&", TokenType.GREATAND],
  ["<", ">", TokenType.LESSGREAT],
  [">", "|", TokenType.CLOBBER],
  ["&", ">", TokenType.AND_GREAT],
];

/**
 * Single-character operators (simple ones without special handling)
 * Note: {, }, ! have special handling, not included here
 */
export const SINGLE_CHAR_OPS: Map<string, TokenType> = new Map<
  string,
  TokenType
>([
  ["|", TokenType.PIPE],
  ["&", TokenType.AMP],
  [";", TokenType.SEMICOLON],
  ["(", TokenType.LPAREN],
  [")", TokenType.RPAREN],
  ["<", TokenType.LESS],
  [">", TokenType.GREAT],
]);

/**
 * Check if a string is a valid variable name
 */
export function isValidName(s: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
}

/**
 * Check if a character is a word boundary (ends a word token)
 */
export function isWordBoundary(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === ";" ||
    char === "&" ||
    char === "|" ||
    char === "(" ||
    char === ")" ||
    char === "<" ||
    char === ">"
  );
}
