/**
 * Lexer module barrel re-export.
 *
 * All public types and the Lexer class are re-exported here so that
 * existing consumers importing from "../parser/lexer.js" continue to work
 * via the updated re-export in the parent lexer.ts file.
 */

export { Lexer } from "./lexer-state-machine.js";

export type { LexerOptions, Token } from "./token-definitions.js";
export {
  DEFAULT_MAX_HEREDOC_SIZE,
  findAssignmentEq,
  isValidAssignmentLHS,
  isValidName,
  isWordBoundary,
  LexerError,
  RESERVED_WORDS,
  SINGLE_CHAR_OPS,
  THREE_CHAR_OPS,
  TokenType,
  TWO_CHAR_OPS,
} from "./token-definitions.js";
