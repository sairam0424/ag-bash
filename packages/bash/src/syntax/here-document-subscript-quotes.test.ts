import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

/**
 * Regression: a heredoc body must NOT strip quotes around bracket-subscript
 * tokens like d['key']. The parser previously treated '[' as the start of a
 * glob bracket-expression and consumed the quote chars as glob syntax.
 *
 * Correct bash semantics:
 * - Quoted-delimiter heredoc body: fully verbatim (zero expansion).
 * - Unquoted-delimiter heredoc body: parameter/command/arithmetic expansion
 *   ONLY; quote and glob metacharacters stay literal.
 */
describe("Here Documents preserve subscript quotes", () => {
  it("preserves d['key'] verbatim in a quoted-delimiter heredoc", async () => {
    const env = new Bash();
    const result = await env.exec(
      `cat > /tmp/a << 'END'
x = 'hi'
y = d['key']
END
cat /tmp/a`,
    );
    expect(result.stdout).toBe("x = 'hi'\ny = d['key']\n");
    expect(result.exitCode).toBe(0);
  });

  it("preserves d['key'] verbatim in an unquoted-delimiter heredoc", async () => {
    const env = new Bash();
    const result = await env.exec(
      `cat > /tmp/b << END
x = 'hi'
y = d['key']
END
cat /tmp/b`,
    );
    expect(result.stdout).toBe("x = 'hi'\ny = d['key']\n");
    expect(result.exitCode).toBe(0);
  });

  it("still expands $VAR in unquoted heredoc while keeping quotes/glob literal", async () => {
    const env = new Bash();
    const result = await env.exec(
      `X=hi
cat > /tmp/c << END
val=$X
y = d['key']
g = *.txt
END
cat /tmp/c`,
    );
    expect(result.stdout).toBe("val=hi\ny = d['key']\ng = *.txt\n");
    expect(result.exitCode).toBe(0);
  });

  it("keeps glob/quote chars literal in quoted heredoc (no expansion)", async () => {
    const env = new Bash();
    const result = await env.exec(
      `X=hi
cat > /tmp/d << 'END'
val=$X
g = *.txt
arr[0]='v'
END
cat /tmp/d`,
    );
    expect(result.stdout).toBe("val=$X\ng = *.txt\narr[0]='v'\n");
    expect(result.exitCode).toBe(0);
  });
});
