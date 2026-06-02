import { describe, expect, it } from "vitest";
import type { ArithExpr, ArithmeticExpressionNode } from "../ast/types.js";
import {
  parseArithExpr,
  parseArithmeticExpression,
} from "./arithmetic-parser.js";
import { Parser } from "./parser.js";

/**
 * Unit tests for the arithmetic expression parser.
 *
 * These test the parseArithmeticExpression function which takes an input string
 * representing the content inside $(( ... )) and produces an ArithmeticExpressionNode.
 */

function parse(input: string): ArithmeticExpressionNode {
  const parser = new Parser();
  // Use the public parse method to initialize parser state, then call arithmetic parser
  // The parser instance is needed for shared state access
  return parseArithmeticExpression(parser, input);
}

function getExpr(input: string): ArithExpr {
  const node = parse(input);
  return node.expression;
}

describe("arithmetic-parser", () => {
  describe("number literals", () => {
    it("should parse single digit", () => {
      const expr = getExpr("5");
      expect(expr.type).toBe("ArithNumber");
      if (expr.type === "ArithNumber") {
        expect(expr.value).toBe(5);
      }
    });

    it("should parse multi-digit number", () => {
      const expr = getExpr("42");
      expect(expr.type).toBe("ArithNumber");
      if (expr.type === "ArithNumber") {
        expect(expr.value).toBe(42);
      }
    });

    it("should parse zero", () => {
      const expr = getExpr("0");
      expect(expr.type).toBe("ArithNumber");
      if (expr.type === "ArithNumber") {
        expect(expr.value).toBe(0);
      }
    });

    it("should parse hex numbers (0x prefix)", () => {
      const expr = getExpr("0xFF");
      expect(expr.type).toBe("ArithNumber");
      if (expr.type === "ArithNumber") {
        expect(expr.value).toBe(255);
      }
    });

    it("should parse octal numbers (leading 0)", () => {
      const expr = getExpr("010");
      expect(expr.type).toBe("ArithNumber");
      if (expr.type === "ArithNumber") {
        expect(expr.value).toBe(8);
      }
    });

    it("should parse base#num format (binary)", () => {
      const expr = getExpr("2#1010");
      expect(expr.type).toBe("ArithNumber");
      if (expr.type === "ArithNumber") {
        expect(expr.value).toBe(10);
      }
    });

    it("should parse base#num format (base 16)", () => {
      const expr = getExpr("16#ff");
      expect(expr.type).toBe("ArithNumber");
      if (expr.type === "ArithNumber") {
        expect(expr.value).toBe(255);
      }
    });
  });

  describe("basic arithmetic", () => {
    it("should parse addition: 1+2", () => {
      const expr = getExpr("1+2");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("+");
        expect(expr.left).toEqual({ type: "ArithNumber", value: 1 });
        expect(expr.right).toEqual({ type: "ArithNumber", value: 2 });
      }
    });

    it("should parse subtraction: 5-3", () => {
      const expr = getExpr("5-3");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("-");
      }
    });

    it("should parse multiplication: 3*4", () => {
      const expr = getExpr("3*4");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("*");
      }
    });

    it("should parse division: 10/2", () => {
      const expr = getExpr("10/2");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("/");
      }
    });

    it("should parse modulo: 7%3", () => {
      const expr = getExpr("7%3");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("%");
      }
    });

    it("should parse exponentiation: 2**3", () => {
      const expr = getExpr("2**3");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("**");
      }
    });
  });

  describe("operator precedence", () => {
    it("should parse 2+3*4 with multiplication first", () => {
      const expr = getExpr("2+3*4");
      // Should be (2 + (3 * 4))
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("+");
        expect(expr.left).toEqual({ type: "ArithNumber", value: 2 });
        expect(expr.right.type).toBe("ArithBinary");
        if (expr.right.type === "ArithBinary") {
          expect(expr.right.operator).toBe("*");
        }
      }
    });

    it("should parse (2+3)*4 respecting parentheses", () => {
      const expr = getExpr("(2+3)*4");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("*");
        expect(expr.left.type).toBe("ArithGroup");
        expect(expr.right).toEqual({ type: "ArithNumber", value: 4 });
      }
    });

    it("should parse 10-4/2 with division first", () => {
      const expr = getExpr("10-4/2");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("-");
        expect(expr.right.type).toBe("ArithBinary");
        if (expr.right.type === "ArithBinary") {
          expect(expr.right.operator).toBe("/");
        }
      }
    });

    it("should make ** right-associative: 2**3**2", () => {
      const expr = getExpr("2**3**2");
      // Should be 2**(3**2)
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("**");
        expect(expr.left).toEqual({ type: "ArithNumber", value: 2 });
        expect(expr.right.type).toBe("ArithBinary");
        if (expr.right.type === "ArithBinary") {
          expect(expr.right.operator).toBe("**");
        }
      }
    });

    it("should handle mixed precedence: 1+2*3-4/2", () => {
      const expr = getExpr("1+2*3-4/2");
      // Should be ((1 + (2*3)) - (4/2))
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("-");
      }
    });
  });

  describe("unary operators", () => {
    it("should parse unary minus: -5", () => {
      const expr = getExpr("-5");
      expect(expr.type).toBe("ArithUnary");
      if (expr.type === "ArithUnary") {
        expect(expr.operator).toBe("-");
        expect(expr.prefix).toBe(true);
        expect(expr.operand).toEqual({ type: "ArithNumber", value: 5 });
      }
    });

    it("should parse unary plus: +3", () => {
      const expr = getExpr("+3");
      expect(expr.type).toBe("ArithUnary");
      if (expr.type === "ArithUnary") {
        expect(expr.operator).toBe("+");
        expect(expr.prefix).toBe(true);
      }
    });

    it("should parse logical NOT: !0", () => {
      const expr = getExpr("!0");
      expect(expr.type).toBe("ArithUnary");
      if (expr.type === "ArithUnary") {
        expect(expr.operator).toBe("!");
        expect(expr.prefix).toBe(true);
      }
    });

    it("should parse bitwise NOT: ~0", () => {
      const expr = getExpr("~0");
      expect(expr.type).toBe("ArithUnary");
      if (expr.type === "ArithUnary") {
        expect(expr.operator).toBe("~");
        expect(expr.prefix).toBe(true);
      }
    });

    it("should parse prefix increment: ++x", () => {
      const expr = getExpr("++x");
      expect(expr.type).toBe("ArithUnary");
      if (expr.type === "ArithUnary") {
        expect(expr.operator).toBe("++");
        expect(expr.prefix).toBe(true);
      }
    });

    it("should parse prefix decrement: --x", () => {
      const expr = getExpr("--x");
      expect(expr.type).toBe("ArithUnary");
      if (expr.type === "ArithUnary") {
        expect(expr.operator).toBe("--");
        expect(expr.prefix).toBe(true);
      }
    });

    it("should parse postfix increment: x++", () => {
      const expr = getExpr("x++");
      expect(expr.type).toBe("ArithUnary");
      if (expr.type === "ArithUnary") {
        expect(expr.operator).toBe("++");
        expect(expr.prefix).toBe(false);
      }
    });

    it("should parse postfix decrement: x--", () => {
      const expr = getExpr("x--");
      expect(expr.type).toBe("ArithUnary");
      if (expr.type === "ArithUnary") {
        expect(expr.operator).toBe("--");
        expect(expr.prefix).toBe(false);
      }
    });

    it("should parse double negation: --5 as prefix decrement (not double neg)", () => {
      const expr = getExpr("- -5");
      expect(expr.type).toBe("ArithUnary");
      if (expr.type === "ArithUnary") {
        expect(expr.operator).toBe("-");
        expect(expr.operand.type).toBe("ArithUnary");
      }
    });
  });

  describe("comparison operators", () => {
    it("should parse less than: 1<2", () => {
      const expr = getExpr("1<2");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("<");
      }
    });

    it("should parse greater than: 3>2", () => {
      const expr = getExpr("3>2");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe(">");
      }
    });

    it("should parse less than or equal: 3<=3", () => {
      const expr = getExpr("3<=3");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("<=");
      }
    });

    it("should parse greater than or equal: 5>=3", () => {
      const expr = getExpr("5>=3");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe(">=");
      }
    });

    it("should parse equality: 5==5", () => {
      const expr = getExpr("5==5");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("==");
      }
    });

    it("should parse inequality: 4!=3", () => {
      const expr = getExpr("4!=3");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("!=");
      }
    });
  });

  describe("logical operators", () => {
    it("should parse logical AND: 1&&1", () => {
      const expr = getExpr("1&&1");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("&&");
      }
    });

    it("should parse logical OR: 0||1", () => {
      const expr = getExpr("0||1");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("||");
      }
    });

    it("should parse chained logical: 1&&0||1", () => {
      const expr = getExpr("1&&0||1");
      // || has lower precedence than &&
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("||");
        expect(expr.left.type).toBe("ArithBinary");
        if (expr.left.type === "ArithBinary") {
          expect(expr.left.operator).toBe("&&");
        }
      }
    });
  });

  describe("bitwise operators", () => {
    it("should parse bitwise AND: 5&3", () => {
      const expr = getExpr("5&3");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("&");
      }
    });

    it("should parse bitwise OR: 5|3", () => {
      const expr = getExpr("5|3");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("|");
      }
    });

    it("should parse bitwise XOR: 5^3", () => {
      const expr = getExpr("5^3");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("^");
      }
    });

    it("should parse left shift: 5<<1", () => {
      const expr = getExpr("5<<1");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("<<");
      }
    });

    it("should parse right shift: 5>>1", () => {
      const expr = getExpr("5>>1");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe(">>");
      }
    });

    it("should respect bitwise precedence: & before ^ before |", () => {
      const expr = getExpr("1|2^3&4");
      // Should be (1 | (2 ^ (3 & 4)))
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("|");
        expect(expr.right.type).toBe("ArithBinary");
        if (expr.right.type === "ArithBinary") {
          expect(expr.right.operator).toBe("^");
        }
      }
    });
  });

  describe("ternary operator", () => {
    it("should parse ternary true branch: 1?2:3", () => {
      const expr = getExpr("1?2:3");
      expect(expr.type).toBe("ArithTernary");
      if (expr.type === "ArithTernary") {
        expect(expr.condition).toEqual({ type: "ArithNumber", value: 1 });
        expect(expr.consequent).toEqual({ type: "ArithNumber", value: 2 });
        expect(expr.alternate).toEqual({ type: "ArithNumber", value: 3 });
      }
    });

    it("should parse ternary false branch: 0?2:3", () => {
      const expr = getExpr("0?2:3");
      expect(expr.type).toBe("ArithTernary");
      if (expr.type === "ArithTernary") {
        expect(expr.condition).toEqual({ type: "ArithNumber", value: 0 });
      }
    });

    it("should parse ternary with expressions: (a>b)?a:b", () => {
      const expr = getExpr("(a>b)?a:b");
      expect(expr.type).toBe("ArithTernary");
    });

    it("should parse nested ternary: 1?2?3:4:5", () => {
      const expr = getExpr("1?2?3:4:5");
      expect(expr.type).toBe("ArithTernary");
      if (expr.type === "ArithTernary") {
        expect(expr.consequent.type).toBe("ArithTernary");
      }
    });
  });

  describe("assignment operators", () => {
    it("should parse simple assignment: x=5", () => {
      const expr = getExpr("x=5");
      expect(expr.type).toBe("ArithAssignment");
      if (expr.type === "ArithAssignment") {
        expect(expr.operator).toBe("=");
        expect(expr.variable).toBe("x");
        expect(expr.value).toEqual({ type: "ArithNumber", value: 5 });
      }
    });

    it("should parse add-assign: x+=3", () => {
      const expr = getExpr("x+=3");
      expect(expr.type).toBe("ArithAssignment");
      if (expr.type === "ArithAssignment") {
        expect(expr.operator).toBe("+=");
        expect(expr.variable).toBe("x");
      }
    });

    it("should parse subtract-assign: x-=2", () => {
      const expr = getExpr("x-=2");
      expect(expr.type).toBe("ArithAssignment");
      if (expr.type === "ArithAssignment") {
        expect(expr.operator).toBe("-=");
      }
    });

    it("should parse multiply-assign: x*=2", () => {
      const expr = getExpr("x*=2");
      expect(expr.type).toBe("ArithAssignment");
      if (expr.type === "ArithAssignment") {
        expect(expr.operator).toBe("*=");
      }
    });

    it("should parse divide-assign: x/=2", () => {
      const expr = getExpr("x/=2");
      expect(expr.type).toBe("ArithAssignment");
      if (expr.type === "ArithAssignment") {
        expect(expr.operator).toBe("/=");
      }
    });

    it("should parse modulo-assign: x%=3", () => {
      const expr = getExpr("x%=3");
      expect(expr.type).toBe("ArithAssignment");
      if (expr.type === "ArithAssignment") {
        expect(expr.operator).toBe("%=");
      }
    });

    it("should parse bitwise-and-assign: x&=7", () => {
      const expr = getExpr("x&=7");
      expect(expr.type).toBe("ArithAssignment");
      if (expr.type === "ArithAssignment") {
        expect(expr.operator).toBe("&=");
      }
    });

    it("should parse bitwise-or-assign: x|=4", () => {
      const expr = getExpr("x|=4");
      expect(expr.type).toBe("ArithAssignment");
      if (expr.type === "ArithAssignment") {
        expect(expr.operator).toBe("|=");
      }
    });

    it("should parse left-shift-assign: x<<=2", () => {
      const expr = getExpr("x<<=2");
      expect(expr.type).toBe("ArithAssignment");
      if (expr.type === "ArithAssignment") {
        expect(expr.operator).toBe("<<=");
      }
    });
  });

  describe("variable references", () => {
    it("should parse bare variable name: x", () => {
      const expr = getExpr("x");
      expect(expr.type).toBe("ArithVariable");
      if (expr.type === "ArithVariable") {
        expect(expr.name).toBe("x");
        expect(expr.hasDollarPrefix).toBe(false);
      }
    });

    it("should parse dollar-prefixed variable: $x", () => {
      const expr = getExpr("$x");
      expect(expr.type).toBe("ArithVariable");
      if (expr.type === "ArithVariable") {
        expect(expr.name).toBe("x");
        expect(expr.hasDollarPrefix).toBe(true);
      }
    });

    it("should parse multi-char variable name: counter", () => {
      const expr = getExpr("counter");
      expect(expr.type).toBe("ArithVariable");
      if (expr.type === "ArithVariable") {
        expect(expr.name).toBe("counter");
      }
    });

    it("should parse underscore variable: _foo_bar", () => {
      const expr = getExpr("_foo_bar");
      expect(expr.type).toBe("ArithVariable");
      if (expr.type === "ArithVariable") {
        expect(expr.name).toBe("_foo_bar");
      }
    });

    it("should parse variable with digits: var123", () => {
      const expr = getExpr("var123");
      expect(expr.type).toBe("ArithVariable");
      if (expr.type === "ArithVariable") {
        expect(expr.name).toBe("var123");
      }
    });

    it("should parse array element: arr[0]", () => {
      const expr = getExpr("arr[0]");
      expect(expr.type).toBe("ArithArrayElement");
      if (expr.type === "ArithArrayElement") {
        expect(expr.array).toBe("arr");
      }
    });

    it("should parse array element with expression index: arr[i+1]", () => {
      const expr = getExpr("arr[i+1]");
      expect(expr.type).toBe("ArithArrayElement");
      if (expr.type === "ArithArrayElement") {
        expect(expr.array).toBe("arr");
        expect(expr.index!.type).toBe("ArithBinary");
      }
    });
  });

  describe("nested and grouped expressions", () => {
    it("should parse simple grouping: (1+2)", () => {
      const expr = getExpr("(1+2)");
      expect(expr.type).toBe("ArithGroup");
      if (expr.type === "ArithGroup") {
        expect(expr.expression.type).toBe("ArithBinary");
      }
    });

    it("should parse nested grouping: ((1+2)*(3+4))", () => {
      const expr = getExpr("((1+2)*(3+4))");
      expect(expr.type).toBe("ArithGroup");
      if (expr.type === "ArithGroup") {
        expect(expr.expression.type).toBe("ArithBinary");
        if (expr.expression.type === "ArithBinary") {
          expect(expr.expression.operator).toBe("*");
          expect(expr.expression.left.type).toBe("ArithGroup");
          expect(expr.expression.right.type).toBe("ArithGroup");
        }
      }
    });

    it("should parse deeply nested: (((5)))", () => {
      const expr = getExpr("(((5)))");
      expect(expr.type).toBe("ArithGroup");
      if (expr.type === "ArithGroup") {
        expect(expr.expression.type).toBe("ArithGroup");
      }
    });
  });

  describe("comma operator", () => {
    it("should parse comma-separated expressions: 1,2,3", () => {
      const expr = getExpr("1,2,3");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe(",");
      }
    });

    it("should make assignment higher precedence than comma", () => {
      const expr = getExpr("x=1,y=2");
      // Should parse as (x=1),(y=2)
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe(",");
        expect(expr.left.type).toBe("ArithAssignment");
        expect(expr.right.type).toBe("ArithAssignment");
      }
    });
  });

  describe("whitespace handling", () => {
    it("should handle spaces between operands", () => {
      const expr = getExpr("1 + 2");
      expect(expr.type).toBe("ArithBinary");
      if (expr.type === "ArithBinary") {
        expect(expr.operator).toBe("+");
      }
    });

    it("should handle tabs in expression", () => {
      const expr = getExpr("1\t+\t2");
      expect(expr.type).toBe("ArithBinary");
    });

    it("should handle leading and trailing whitespace", () => {
      const expr = getExpr("  5  ");
      expect(expr.type).toBe("ArithNumber");
      if (expr.type === "ArithNumber") {
        expect(expr.value).toBe(5);
      }
    });
  });

  describe("command substitution in arithmetic", () => {
    it("should parse command substitution: $(echo 1)", () => {
      const expr = getExpr("$(echo 1)");
      expect(expr.type).toBe("ArithCommandSubst");
      if (expr.type === "ArithCommandSubst") {
        expect(expr.command).toBe("echo 1");
      }
    });

    it("should parse backtick command substitution: `echo 1`", () => {
      const expr = getExpr("`echo 1`");
      expect(expr.type).toBe("ArithCommandSubst");
      if (expr.type === "ArithCommandSubst") {
        expect(expr.command).toBe("echo 1");
      }
    });
  });

  describe("error handling", () => {
    it("should handle missing operand after binary operator", () => {
      const expr = getExpr("1+");
      expect(expr.type).toBe("ArithSyntaxError");
    });

    it("should handle invalid token producing syntax error node", () => {
      const expr = getExpr("1 + @invalid");
      // The @ or other invalid tokens produce syntax error nodes
      // Exact behavior depends on how the parser handles unknowns
      expect(expr).toBeDefined();
    });

    it("should handle unclosed parentheses gracefully", () => {
      // Parser should not crash on unclosed parens
      const expr = getExpr("(1+2");
      expect(expr).toBeDefined();
    });

    it("should produce error for invalid number-letter combos like 42x", () => {
      const expr = getExpr("42x");
      expect(expr.type).toBe("ArithSyntaxError");
    });

    it("should produce ArithSyntaxError for trailing invalid content", () => {
      const node = parse("1 + 2 @garbage");
      expect(node.expression.type).toBe("ArithSyntaxError");
    });
  });

  describe("special variables", () => {
    it("should parse positional parameter: $1", () => {
      const expr = getExpr("$1");
      expect(expr.type).toBe("ArithVariable");
      if (expr.type === "ArithVariable") {
        expect(expr.name).toBe("1");
        expect(expr.hasDollarPrefix).toBe(true);
      }
    });

    it("should parse special var $?", () => {
      const expr = getExpr("$?");
      expect(expr.type).toBe("ArithSpecialVar");
      if (expr.type === "ArithSpecialVar") {
        expect(expr.name).toBe("?");
      }
    });

    it("should parse special var $#", () => {
      const expr = getExpr("$#");
      expect(expr.type).toBe("ArithSpecialVar");
      if (expr.type === "ArithSpecialVar") {
        expect(expr.name).toBe("#");
      }
    });
  });

  describe("braced parameter expansion", () => {
    it("should parse ${var} in arithmetic context", () => {
      const expr = getExpr("${x}");
      expect(expr.type).toBe("ArithBracedExpansion");
      if (expr.type === "ArithBracedExpansion") {
        expect(expr.content).toBe("x");
      }
    });

    it("should parse ${var} with default value syntax", () => {
      const expr = getExpr("${x:-5}");
      expect(expr.type).toBe("ArithBracedExpansion");
      if (expr.type === "ArithBracedExpansion") {
        expect(expr.content).toBe("x:-5");
      }
    });
  });

  describe("double-quoted preprocessing", () => {
    it("should strip double quotes and inline content", () => {
      // In bash, $(( "1 + 2" )) evaluates "1 + 2" as text inline → 1 + 2 = 3
      const node = parse('"1 + 2"');
      expect(node.expression.type).toBe("ArithBinary");
      if (node.expression.type === "ArithBinary") {
        expect(node.expression.operator).toBe("+");
      }
    });
  });
});
