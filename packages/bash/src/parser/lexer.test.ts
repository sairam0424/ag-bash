import { describe, expect, it } from "vitest";
import type { Token } from "./lexer.js";
import { Lexer, TokenType } from "./lexer.js";

/**
 * Unit tests for the Bash lexer/tokenizer.
 */

function tokenize(input: string): Token[] {
  const lexer = new Lexer(input);
  return lexer.tokenize();
}

function tokenTypes(input: string): TokenType[] {
  return tokenize(input).map((t) => t.type);
}

describe("lexer", () => {
  describe("basic word tokenization", () => {
    it("should tokenize a simple word", () => {
      const tokens = tokenize("hello");
      // Pure alpha strings are NAME tokens (valid variable names)
      expect(tokens[0].type).toBe(TokenType.NAME);
      expect(tokens[0].value).toBe("hello");
      expect(tokens[1].type).toBe(TokenType.EOF);
    });

    it("should tokenize multiple words separated by spaces", () => {
      const tokens = tokenize("echo hello world");
      // echo, hello, world are all valid names
      expect(tokens[0].type).toBe(TokenType.NAME);
      expect(tokens[0].value).toBe("echo");
      expect(tokens[1].type).toBe(TokenType.NAME);
      expect(tokens[1].value).toBe("hello");
      expect(tokens[2].type).toBe(TokenType.NAME);
      expect(tokens[2].value).toBe("world");
    });

    it("should tokenize words separated by tabs", () => {
      const tokens = tokenize("echo\thello");
      expect(tokens[0].value).toBe("echo");
      expect(tokens[1].value).toBe("hello");
    });

    it("should handle mixed whitespace between words", () => {
      const tokens = tokenize("echo  \t  hello");
      expect(tokens[0].value).toBe("echo");
      expect(tokens[1].value).toBe("hello");
    });

    it("should tokenize non-name words as WORD tokens", () => {
      const tokens = tokenize("echo hello-world");
      // "hello-world" has a dash, so it's a WORD not a NAME
      expect(tokens[1].type).toBe(TokenType.WORD);
      expect(tokens[1].value).toBe("hello-world");
    });

    it("should tokenize single-quoted strings as a word", () => {
      const tokens = tokenize("echo 'hello world'");
      expect(tokens[1].type).toBe(TokenType.WORD);
      expect(tokens[1].value).toContain("hello world");
      expect(tokens[1].singleQuoted).toBe(true);
    });

    it("should tokenize double-quoted strings as a word", () => {
      const tokens = tokenize('echo "hello world"');
      expect(tokens[1].type).toBe(TokenType.WORD);
      expect(tokens[1].value).toContain("hello world");
      expect(tokens[1].quoted).toBe(true);
    });

    it("should tokenize variable expansions in words", () => {
      const tokens = tokenize("echo $HOME");
      expect(tokens[1].type).toBe(TokenType.WORD);
      expect(tokens[1].value).toBe("$HOME");
    });

    it("should tokenize braced variable expansions", () => {
      const tokens = tokenize("echo ${HOME}");
      expect(tokens[1].type).toBe(TokenType.WORD);
      expect(tokens[1].value).toBe("${HOME}");
    });
  });

  describe("operator tokens", () => {
    it("should tokenize pipe operator: |", () => {
      const tokens = tokenize("a | b");
      expect(tokens[1].type).toBe(TokenType.PIPE);
      expect(tokens[1].value).toBe("|");
    });

    it("should tokenize logical OR: ||", () => {
      const tokens = tokenize("a || b");
      expect(tokens[1].type).toBe(TokenType.OR_OR);
    });

    it("should tokenize background operator: &", () => {
      const tokens = tokenize("sleep 1 &");
      expect(tokens[2].type).toBe(TokenType.AMP);
    });

    it("should tokenize logical AND: &&", () => {
      const tokens = tokenize("a && b");
      expect(tokens[1].type).toBe(TokenType.AND_AND);
    });

    it("should tokenize semicolon: ;", () => {
      const tokens = tokenize("a; b");
      expect(tokens[1].type).toBe(TokenType.SEMICOLON);
    });

    it("should tokenize double semicolon: ;;", () => {
      const tokens = tokenize(";;");
      expect(tokens[0].type).toBe(TokenType.DSEMI);
    });

    it("should tokenize left paren: (", () => {
      const tokens = tokenize("(echo hi)");
      expect(tokens[0].type).toBe(TokenType.LPAREN);
    });

    it("should tokenize right paren: )", () => {
      const tokens = tokenize("(echo hi)");
      const rparen = tokens.find((t) => t.type === TokenType.RPAREN);
      expect(rparen).toBeDefined();
    });

    it("should tokenize pipe-and: |&", () => {
      const tokens = tokenize("a |& b");
      expect(tokens[1].type).toBe(TokenType.PIPE_AMP);
    });

    it("should tokenize semi-and: ;&", () => {
      const tokens = tokenize(";&");
      expect(tokens[0].type).toBe(TokenType.SEMI_AND);
    });
  });

  describe("redirection tokens", () => {
    it("should tokenize output redirect: >", () => {
      const tokens = tokenize("echo hi > file");
      const redir = tokens.find((t) => t.type === TokenType.GREAT);
      expect(redir).toBeDefined();
    });

    it("should tokenize input redirect: <", () => {
      const tokens = tokenize("cat < file");
      const redir = tokens.find((t) => t.type === TokenType.LESS);
      expect(redir).toBeDefined();
    });

    it("should tokenize append redirect: >>", () => {
      const tokens = tokenize("echo hi >> file");
      const redir = tokens.find((t) => t.type === TokenType.DGREAT);
      expect(redir).toBeDefined();
    });

    it("should tokenize heredoc start: <<", () => {
      const tokens = tokenize("cat <<EOF\nhello\nEOF");
      const heredoc = tokens.find((t) => t.type === TokenType.DLESS);
      expect(heredoc).toBeDefined();
    });

    it("should tokenize heredoc with tab stripping: <<-", () => {
      const tokens = tokenize("cat <<-EOF\n\thello\n\tEOF");
      const heredoc = tokens.find((t) => t.type === TokenType.DLESSDASH);
      expect(heredoc).toBeDefined();
    });

    it("should tokenize herestring: <<<", () => {
      const tokens = tokenize("cat <<< 'hello'");
      const herestring = tokens.find((t) => t.type === TokenType.TLESS);
      expect(herestring).toBeDefined();
    });

    it("should tokenize fd duplication: <&", () => {
      const tokens = tokenize("cmd <& 3");
      const redir = tokens.find((t) => t.type === TokenType.LESSAND);
      expect(redir).toBeDefined();
    });

    it("should tokenize fd duplication: >&", () => {
      const tokens = tokenize("cmd >& 2");
      const redir = tokens.find((t) => t.type === TokenType.GREATAND);
      expect(redir).toBeDefined();
    });

    it("should tokenize clobber: >|", () => {
      const tokens = tokenize("echo hi >| file");
      const redir = tokens.find((t) => t.type === TokenType.CLOBBER);
      expect(redir).toBeDefined();
    });

    it("should tokenize read-write redirect: <>", () => {
      const tokens = tokenize("cmd <> file");
      const redir = tokens.find((t) => t.type === TokenType.LESSGREAT);
      expect(redir).toBeDefined();
    });

    it("should tokenize &>", () => {
      const tokens = tokenize("cmd &> /dev/null");
      const redir = tokens.find((t) => t.type === TokenType.AND_GREAT);
      expect(redir).toBeDefined();
    });

    it("should tokenize &>>", () => {
      const tokens = tokenize("cmd &>> file");
      const redir = tokens.find((t) => t.type === TokenType.AND_DGREAT);
      expect(redir).toBeDefined();
    });
  });

  describe("reserved words", () => {
    it("should recognize 'if' as reserved word", () => {
      const tokens = tokenize("if true; then echo hi; fi");
      expect(tokens[0].type).toBe(TokenType.IF);
    });

    it("should recognize 'then' as reserved word", () => {
      const tokens = tokenize("if true; then echo hi; fi");
      const then = tokens.find((t) => t.type === TokenType.THEN);
      expect(then).toBeDefined();
    });

    it("should recognize 'fi' as reserved word", () => {
      const tokens = tokenize("if true; then echo hi; fi");
      const fi = tokens.find((t) => t.type === TokenType.FI);
      expect(fi).toBeDefined();
    });

    it("should recognize 'for' as reserved word", () => {
      const tokens = tokenize("for i in 1 2 3; do echo $i; done");
      expect(tokens[0].type).toBe(TokenType.FOR);
    });

    it("should recognize 'while' as reserved word", () => {
      const tokens = tokenize("while true; do echo loop; done");
      expect(tokens[0].type).toBe(TokenType.WHILE);
    });

    it("should recognize 'case' as reserved word", () => {
      const tokens = tokenize("case x in *) ;; esac");
      expect(tokens[0].type).toBe(TokenType.CASE);
    });

    it("should recognize 'function' as reserved word", () => {
      const tokens = tokenize("function foo { echo hi; }");
      expect(tokens[0].type).toBe(TokenType.FUNCTION);
    });

    it("should recognize 'do' and 'done' as reserved words", () => {
      const types = tokenTypes("for i in 1; do echo $i; done");
      expect(types).toContain(TokenType.DO);
      expect(types).toContain(TokenType.DONE);
    });

    it("should recognize 'else' and 'elif' as reserved words", () => {
      const types = tokenTypes("if a; then b; elif c; then d; else e; fi");
      expect(types).toContain(TokenType.ELSE);
      expect(types).toContain(TokenType.ELIF);
    });
  });

  describe("comment handling", () => {
    it("should tokenize a line comment", () => {
      const tokens = tokenize("# this is a comment");
      expect(tokens[0].type).toBe(TokenType.COMMENT);
      expect(tokens[0].value).toContain("this is a comment");
    });

    it("should tokenize comment after a command", () => {
      const tokens = tokenize("echo hello # comment");
      const comment = tokens.find((t) => t.type === TokenType.COMMENT);
      expect(comment).toBeDefined();
    });

    it("should NOT treat # inside single quotes as comment", () => {
      const tokens = tokenize("echo '# not a comment'");
      const comment = tokens.find((t) => t.type === TokenType.COMMENT);
      expect(comment).toBeUndefined();
    });

    it("should NOT treat # inside double quotes as comment", () => {
      const tokens = tokenize('echo "# not a comment"');
      const comment = tokens.find((t) => t.type === TokenType.COMMENT);
      expect(comment).toBeUndefined();
    });

    it("should NOT treat # inside a word as comment", () => {
      // # preceded by non-whitespace is not a comment
      const tokens = tokenize("echo foo#bar");
      const comment = tokens.find((t) => t.type === TokenType.COMMENT);
      expect(comment).toBeUndefined();
    });
  });

  describe("assignment word detection", () => {
    it("should detect simple assignment: VAR=value", () => {
      const tokens = tokenize("VAR=value");
      expect(tokens[0].type).toBe(TokenType.ASSIGNMENT_WORD);
    });

    it("should detect empty assignment: VAR=", () => {
      const tokens = tokenize("VAR=");
      expect(tokens[0].type).toBe(TokenType.ASSIGNMENT_WORD);
    });

    it("should detect append assignment: VAR+=value", () => {
      const tokens = tokenize("VAR+=value");
      expect(tokens[0].type).toBe(TokenType.ASSIGNMENT_WORD);
    });

    it("should detect array assignment: arr[0]=value", () => {
      const tokens = tokenize("arr[0]=value");
      expect(tokens[0].type).toBe(TokenType.ASSIGNMENT_WORD);
    });
  });

  describe("grouping tokens", () => {
    it("should tokenize left brace: {", () => {
      const tokens = tokenize("{ echo hi; }");
      expect(tokens[0].type).toBe(TokenType.LBRACE);
    });

    it("should tokenize right brace: }", () => {
      const tokens = tokenize("{ echo hi; }");
      const rbrace = tokens.find((t) => t.type === TokenType.RBRACE);
      expect(rbrace).toBeDefined();
    });

    it("should tokenize [[ as DBRACK_START", () => {
      const tokens = tokenize("[[ -f file ]]");
      expect(tokens[0].type).toBe(TokenType.DBRACK_START);
    });

    it("should tokenize ]] as DBRACK_END", () => {
      const tokens = tokenize("[[ -f file ]]");
      const end = tokens.find((t) => t.type === TokenType.DBRACK_END);
      expect(end).toBeDefined();
    });

    it("should tokenize (( as DPAREN_START", () => {
      const tokens = tokenize("((1+2))");
      expect(tokens[0].type).toBe(TokenType.DPAREN_START);
    });

    it("should tokenize )) as DPAREN_END", () => {
      const tokens = tokenize("((1+2))");
      const end = tokens.find((t) => t.type === TokenType.DPAREN_END);
      expect(end).toBeDefined();
    });
  });

  describe("newline handling", () => {
    it("should tokenize newlines", () => {
      const tokens = tokenize("echo hi\necho bye");
      const newlines = tokens.filter((t) => t.type === TokenType.NEWLINE);
      expect(newlines.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle line continuation (backslash-newline)", () => {
      // Use a raw string with actual backslash followed by newline
      const input = "echo \\\nhello";
      const tokens = tokenize(input);
      // Line continuation means the backslash-newline is skipped in whitespace
      // "echo" and "hello" should both appear as NAME tokens (valid identifiers)
      const names = tokens.filter(
        (t) => t.type === TokenType.NAME || t.type === TokenType.WORD,
      );
      expect(names.length).toBe(2);
      expect(names[0].value).toBe("echo");
      expect(names[1].value).toBe("hello");
    });

    it("should track line numbers correctly", () => {
      const tokens = tokenize("echo one\necho two\necho three");
      expect(tokens[0].line).toBe(1);
      // "two" is a NAME token (valid variable name)
      const secondTwo = tokens.find(
        (t) =>
          (t.type === TokenType.NAME || t.type === TokenType.WORD) &&
          t.value === "two",
      );
      expect(secondTwo?.line).toBe(2);
    });
  });

  describe("escape sequences", () => {
    it("should handle escaped space in word", () => {
      const tokens = tokenize("echo hello\\ world");
      // "hello\ world" is one word due to escaped space
      expect(tokens[1].type).toBe(TokenType.WORD);
      expect(tokens[1].value).toContain("hello");
      expect(tokens[1].value).toContain("world");
    });

    it("should handle escaped dollar sign", () => {
      const tokens = tokenize("echo \\$HOME");
      expect(tokens[1].type).toBe(TokenType.WORD);
      expect(tokens[1].value).toContain("\\$HOME");
    });

    it("should handle escaped backslash", () => {
      const tokens = tokenize("echo \\\\");
      expect(tokens[1].type).toBe(TokenType.WORD);
    });

    it("should handle escaped double quote", () => {
      const tokens = tokenize('echo \\"hello\\"');
      expect(tokens[1].type).toBe(TokenType.WORD);
    });
  });

  describe("special character handling", () => {
    it("should handle bang operator: !", () => {
      const tokens = tokenize("! true");
      expect(tokens[0].type).toBe(TokenType.BANG);
    });

    it("should handle != as a WORD (for test expressions)", () => {
      const tokens = tokenize("!=");
      expect(tokens[0].type).toBe(TokenType.WORD);
      expect(tokens[0].value).toBe("!=");
    });
  });

  describe("heredoc content", () => {
    it("should capture heredoc content", () => {
      const tokens = tokenize("cat <<EOF\nhello world\nEOF");
      const content = tokens.find((t) => t.type === TokenType.HEREDOC_CONTENT);
      expect(content).toBeDefined();
      expect(content?.value).toContain("hello world");
    });

    it("should handle heredoc with quoted delimiter (no expansion)", () => {
      const tokens = tokenize("cat <<'EOF'\n$HOME\nEOF");
      const content = tokens.find((t) => t.type === TokenType.HEREDOC_CONTENT);
      expect(content).toBeDefined();
      expect(content?.value).toContain("$HOME");
    });

    it("should handle heredoc with double-quoted delimiter", () => {
      const tokens = tokenize('cat <<"EOF"\nhello\nEOF');
      const content = tokens.find((t) => t.type === TokenType.HEREDOC_CONTENT);
      expect(content).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("should handle empty input", () => {
      const tokens = tokenize("");
      expect(tokens.length).toBe(1);
      expect(tokens[0].type).toBe(TokenType.EOF);
    });

    it("should handle only whitespace", () => {
      const tokens = tokenize("   \t   ");
      expect(tokens.length).toBe(1);
      expect(tokens[0].type).toBe(TokenType.EOF);
    });

    it("should handle only newlines", () => {
      const tokens = tokenize("\n\n\n");
      const types = tokens.map((t) => t.type);
      // Should have NEWLINE tokens followed by EOF
      expect(types[types.length - 1]).toBe(TokenType.EOF);
      expect(types.filter((t) => t === TokenType.NEWLINE).length).toBe(3);
    });

    it("should handle very long word without crashing", () => {
      const longWord = "a".repeat(10000);
      const tokens = tokenize(longWord);
      // A pure alpha string is a valid NAME
      expect(tokens[0].type).toBe(TokenType.NAME);
      expect(tokens[0].value).toBe(longWord);
    });

    it("should handle very long non-name word without crashing", () => {
      const longWord = "a-b".repeat(3000);
      const tokens = tokenize(longWord);
      expect(tokens[0].type).toBe(TokenType.WORD);
      expect(tokens[0].value).toBe(longWord);
    });

    it("should provide correct start/end positions", () => {
      const tokens = tokenize("echo hello");
      expect(tokens[0].start).toBe(0);
      expect(tokens[0].end).toBe(4);
      expect(tokens[1].start).toBe(5);
      expect(tokens[1].end).toBe(10);
    });

    it("should track column numbers correctly", () => {
      const tokens = tokenize("echo hello");
      expect(tokens[0].column).toBe(1);
      expect(tokens[1].column).toBe(6);
    });

    it("should handle {} as a word (find -exec pattern)", () => {
      const tokens = tokenize("find . -exec rm {} ;");
      const braces = tokens.find(
        (t) => t.type === TokenType.WORD && t.value === "{}",
      );
      expect(braces).toBeDefined();
    });

    it("should tokenize number before redirect as NUMBER", () => {
      const tokens = tokenize("2>&1");
      expect(tokens[0].type).toBe(TokenType.NUMBER);
      expect(tokens[0].value).toBe("2");
    });

    it("should always end with EOF token", () => {
      const inputs = ["", "echo", "a | b", "if true; then x; fi"];
      for (const input of inputs) {
        const tokens = tokenize(input);
        expect(tokens[tokens.length - 1].type).toBe(TokenType.EOF);
      }
    });
  });

  describe("complex tokenization scenarios", () => {
    it("should tokenize a full pipeline", () => {
      const types = tokenTypes("cat file | grep pattern | wc -l");
      expect(types).toContain(TokenType.PIPE);
      expect(types.filter((t) => t === TokenType.PIPE).length).toBe(2);
    });

    it("should tokenize compound command with redirects", () => {
      const tokens = tokenize("{ echo a; echo b; } > out.txt");
      expect(tokens[0].type).toBe(TokenType.LBRACE);
      const great = tokens.find((t) => t.type === TokenType.GREAT);
      expect(great).toBeDefined();
    });

    it("should tokenize for loop structure", () => {
      const types = tokenTypes("for i in 1 2 3; do echo $i; done");
      expect(types[0]).toBe(TokenType.FOR);
      expect(types).toContain(TokenType.IN);
      expect(types).toContain(TokenType.DO);
      expect(types).toContain(TokenType.DONE);
    });

    it("should tokenize case statement structure", () => {
      const types = tokenTypes("case $x in a) echo a;; b) echo b;; esac");
      expect(types[0]).toBe(TokenType.CASE);
      expect(types).toContain(TokenType.IN);
      expect(types).toContain(TokenType.DSEMI);
      expect(types).toContain(TokenType.ESAC);
    });

    it("should tokenize subshell", () => {
      const tokens = tokenize("(echo hello)");
      expect(tokens[0].type).toBe(TokenType.LPAREN);
      const rparen = tokens.find((t) => t.type === TokenType.RPAREN);
      expect(rparen).toBeDefined();
    });
  });
});
