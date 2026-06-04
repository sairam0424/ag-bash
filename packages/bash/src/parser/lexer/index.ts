/**
 * Lexer module barrel re-export.
 *
 * All public types and the Lexer class are re-exported here so that
 * existing consumers importing from "../parser/lexer.js" continue to work
 * via the updated re-export in the parent lexer.ts file.
 */

export { Lexer } from "./lexer-state-machine.js";

export type { LexerOptions, Token } from "./token-definitions.js";
export { LexerError, TokenType } from "./token-definitions.js";
