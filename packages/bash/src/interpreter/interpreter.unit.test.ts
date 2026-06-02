/**
 * Interpreter Core Unit Tests
 *
 * Comprehensive unit tests for the interpreter execution engine.
 * Tests cover all major AST node types and execution paths.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { Bash } from "../Bash.js";

describe("Interpreter Core", () => {
  let bash: Bash;

  beforeEach(() => {
    bash = new Bash();
  });

  // ===========================================================================
  // 1. Simple Commands
  // ===========================================================================

  describe("simple commands", () => {
    it("should execute echo with string argument", async () => {
      const result = await bash.exec("echo hello");
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should execute echo with multiple arguments", async () => {
      const result = await bash.exec("echo hello world");
      expect(result.stdout).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
    });

    it("should execute printf with format string", async () => {
      const result = await bash.exec('printf "%s %s\\n" hello world');
      expect(result.stdout).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
    });

    it("should propagate exit code from true", async () => {
      const result = await bash.exec("true");
      expect(result.exitCode).toBe(0);
    });

    it("should propagate exit code from false", async () => {
      const result = await bash.exec("false");
      expect(result.exitCode).toBe(1);
    });

    it("should propagate custom exit code", async () => {
      const result = await bash.exec("exit 42");
      expect(result.exitCode).toBe(42);
    });

    it("should return exit code 127 for command not found", async () => {
      const result = await bash.exec("nonexistent_command_xyz");
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain("not found");
    });

    it("should execute multiple commands separated by semicolon", async () => {
      const result = await bash.exec("echo one; echo two; echo three");
      expect(result.stdout).toBe("one\ntwo\nthree\n");
    });
  });

  // ===========================================================================
  // 2. Pipelines
  // ===========================================================================

  describe("pipelines", () => {
    it("should pipe output between two commands", async () => {
      const result = await bash.exec("echo hello | cat");
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should pipe through tr for uppercase conversion", async () => {
      const result = await bash.exec("echo hello | tr a-z A-Z");
      expect(result.stdout).toBe("HELLO\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support multi-stage pipeline", async () => {
      const result = await bash.exec("echo hello | tr a-z A-Z | cat");
      expect(result.stdout).toBe("HELLO\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use exit code from last command in pipeline", async () => {
      const result = await bash.exec("echo hello | grep nomatch");
      expect(result.exitCode).toBe(1);
    });

    it("should succeed when last command matches", async () => {
      const result = await bash.exec("echo hello | grep hello");
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support pipeline with wc", async () => {
      const result = await bash.exec('echo -e "a\\nb\\nc" | wc -l');
      expect(result.stdout.trim()).toBe("3");
    });

    it.skip("should set PIPESTATUS for pipeline", async () => {
      const result = await bash.exec(
        'false | true | echo "${PIPESTATUS[0]} ${PIPESTATUS[1]} ${PIPESTATUS[2]}"',
      );
      expect(result.stdout.trim()).toBe("1 0 0");
    });
  });

  // ===========================================================================
  // 3. Control Flow
  // ===========================================================================

  describe("control flow", () => {
    describe("if/then/else", () => {
      it("should execute then-branch when condition is true", async () => {
        const result = await bash.exec(`
          if true; then
            echo "yes"
          fi
        `);
        expect(result.stdout).toBe("yes\n");
        expect(result.exitCode).toBe(0);
      });

      it("should execute else-branch when condition is false", async () => {
        const result = await bash.exec(`
          if false; then
            echo "yes"
          else
            echo "no"
          fi
        `);
        expect(result.stdout).toBe("no\n");
        expect(result.exitCode).toBe(0);
      });

      it("should evaluate elif correctly", async () => {
        const result = await bash.exec(`
          x=2
          if [ $x -eq 1 ]; then
            echo "one"
          elif [ $x -eq 2 ]; then
            echo "two"
          else
            echo "other"
          fi
        `);
        expect(result.stdout).toBe("two\n");
      });
    });

    describe("while loop", () => {
      it("should iterate while condition is true", async () => {
        const result = await bash.exec(`
          i=0
          while [ $i -lt 3 ]; do
            echo $i
            i=$((i + 1))
          done
        `);
        expect(result.stdout).toBe("0\n1\n2\n");
        expect(result.exitCode).toBe(0);
      });

      it("should not execute body when condition is initially false", async () => {
        const result = await bash.exec(`
          while false; do
            echo "never"
          done
          echo "done"
        `);
        expect(result.stdout).toBe("done\n");
      });
    });

    describe("for loop", () => {
      it("should iterate over word list", async () => {
        const result = await bash.exec(`
          for x in a b c; do
            echo $x
          done
        `);
        expect(result.stdout).toBe("a\nb\nc\n");
        expect(result.exitCode).toBe(0);
      });

      it("should iterate over command substitution results", async () => {
        const result = await bash.exec(`
          for x in $(echo "one two three"); do
            echo $x
          done
        `);
        expect(result.stdout).toBe("one\ntwo\nthree\n");
      });

      it("should support C-style for loop", async () => {
        const result = await bash.exec(`
          for ((i=0; i<3; i++)); do
            echo $i
          done
        `);
        expect(result.stdout).toBe("0\n1\n2\n");
      });
    });

    describe("until loop", () => {
      it("should iterate until condition becomes true", async () => {
        const result = await bash.exec(`
          i=0
          until [ $i -ge 3 ]; do
            echo $i
            i=$((i + 1))
          done
        `);
        expect(result.stdout).toBe("0\n1\n2\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("case statement", () => {
      it("should match simple pattern", async () => {
        const result = await bash.exec(`
          x="hello"
          case $x in
            hello) echo "matched" ;;
            *) echo "no match" ;;
          esac
        `);
        expect(result.stdout).toBe("matched\n");
      });

      it("should match wildcard pattern", async () => {
        const result = await bash.exec(`
          x="something"
          case $x in
            hello) echo "hello" ;;
            *) echo "default" ;;
          esac
        `);
        expect(result.stdout).toBe("default\n");
      });

      it("should match with pipe-separated alternatives", async () => {
        const result = await bash.exec(`
          x="bar"
          case $x in
            foo|bar|baz) echo "matched" ;;
            *) echo "no match" ;;
          esac
        `);
        expect(result.stdout).toBe("matched\n");
      });
    });
  });

  // ===========================================================================
  // 4. Compound Commands
  // ===========================================================================

  describe("compound commands", () => {
    describe("command grouping with { }", () => {
      it("should execute grouped commands", async () => {
        const result = await bash.exec("{ echo one; echo two; }");
        expect(result.stdout).toBe("one\ntwo\n");
        expect(result.exitCode).toBe(0);
      });

      it("should share variable scope with parent", async () => {
        const result = await bash.exec(`
          x=before
          { x=after; }
          echo $x
        `);
        expect(result.stdout).toBe("after\n");
      });
    });

    describe("subshell with ( )", () => {
      it("should execute subshell commands", async () => {
        const result = await bash.exec("(echo hello)");
        expect(result.stdout).toBe("hello\n");
        expect(result.exitCode).toBe(0);
      });

      it("should isolate variable changes from parent", async () => {
        const result = await bash.exec(`
          x=before
          (x=after)
          echo $x
        `);
        expect(result.stdout).toBe("before\n");
      });

      it("should isolate cd changes from parent", async () => {
        const env = new Bash({
          files: {
            "/home/user/.keep": "",
            "/tmp/.keep": "",
          },
        });
        const result = await env.exec(`
          cd /home/user
          (cd /tmp)
          pwd
        `);
        expect(result.stdout).toBe("/home/user\n");
      });

      it("should propagate exit code from subshell", async () => {
        const result = await bash.exec("(exit 42)");
        expect(result.exitCode).toBe(42);
      });
    });
  });

  // ===========================================================================
  // 5. Redirections
  // ===========================================================================

  describe("redirections", () => {
    it("should redirect stdout to file", async () => {
      const env = new Bash();
      await env.exec("echo hello > /tmp/test.txt");
      const result = await env.exec("cat /tmp/test.txt");
      expect(result.stdout).toBe("hello\n");
    });

    it("should redirect stderr with 2>", async () => {
      const env = new Bash();
      const result = await env.exec("echo error >&2");
      expect(result.stderr).toBe("error\n");
      expect(result.stdout).toBe("");
    });

    it("should append to file with >>", async () => {
      const env = new Bash({
        files: { "/tmp/test.txt": "line1\n" },
      });
      await env.exec("echo line2 >> /tmp/test.txt");
      const result = await env.exec("cat /tmp/test.txt");
      expect(result.stdout).toBe("line1\nline2\n");
    });

    it("should redirect input with <", async () => {
      const env = new Bash({
        files: { "/tmp/input.txt": "hello world\n" },
      });
      const result = await env.exec("cat < /tmp/input.txt");
      expect(result.stdout).toBe("hello world\n");
    });

    it("should overwrite file with >", async () => {
      const env = new Bash({
        files: { "/tmp/test.txt": "old content\n" },
      });
      await env.exec("echo new > /tmp/test.txt");
      const result = await env.exec("cat /tmp/test.txt");
      expect(result.stdout).toBe("new\n");
    });

    it("should redirect stderr to file", async () => {
      const env = new Bash();
      await env.exec("echo error >&2 2>/tmp/err.txt");
      const result = await env.exec("cat /tmp/err.txt");
      expect(result.stdout).toBe("error\n");
    });
  });

  // ===========================================================================
  // 6. Variable Operations
  // ===========================================================================

  describe("variable operations", () => {
    it("should assign and read a variable", async () => {
      const result = await bash.exec('FOO=bar; echo $FOO');
      expect(result.stdout).toBe("bar\n");
    });

    it("should expand variable in double quotes", async () => {
      const result = await bash.exec('NAME=world; echo "hello $NAME"');
      expect(result.stdout).toBe("hello world\n");
    });

    it("should not expand variable in single quotes", async () => {
      const result = await bash.exec("NAME=world; echo 'hello $NAME'");
      expect(result.stdout).toBe("hello $NAME\n");
    });

    it("should export variable to subshell", async () => {
      const result = await bash.exec("export FOO=bar; (echo $FOO)");
      expect(result.stdout).toBe("bar\n");
    });

    it("should handle assignment with command substitution", async () => {
      const result = await bash.exec('X=$(echo hello); echo $X');
      expect(result.stdout).toBe("hello\n");
    });

    it("should support default value expansion", async () => {
      const result = await bash.exec('echo ${UNSET:-default}');
      expect(result.stdout).toBe("default\n");
    });

    it("should support string length with ${#var}", async () => {
      const result = await bash.exec('X=hello; echo ${#X}');
      expect(result.stdout).toBe("5\n");
    });

    it("should support basic indexed array", async () => {
      const result = await bash.exec(`
        arr=(one two three)
        echo \${arr[0]}
        echo \${arr[1]}
        echo \${arr[2]}
      `);
      expect(result.stdout).toBe("one\ntwo\nthree\n");
    });

    it("should support array length", async () => {
      const result = await bash.exec(`
        arr=(a b c d)
        echo \${#arr[@]}
      `);
      expect(result.stdout).toBe("4\n");
    });
  });

  // ===========================================================================
  // 7. Functions
  // ===========================================================================

  describe("functions", () => {
    it("should define and call a function", async () => {
      const result = await bash.exec(`
        greet() {
          echo "hello"
        }
        greet
      `);
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should pass positional arguments to function", async () => {
      const result = await bash.exec(`
        greet() {
          echo "hello $1"
        }
        greet world
      `);
      expect(result.stdout).toBe("hello world\n");
    });

    it("should return a value from function", async () => {
      const result = await bash.exec(`
        check() {
          return 42
        }
        check
        echo $?
      `);
      expect(result.stdout).toBe("42\n");
    });

    it("should support local variables in function", async () => {
      const result = await bash.exec(`
        myfunc() {
          local x=inside
          echo $x
        }
        x=outside
        myfunc
        echo $x
      `);
      expect(result.stdout).toBe("inside\noutside\n");
    });

    it("should support recursive functions", async () => {
      const result = await bash.exec(`
        factorial() {
          local n=$1
          if [ $n -le 1 ]; then
            echo 1
          else
            local sub=$(factorial $((n - 1)))
            echo $((n * sub))
          fi
        }
        factorial 5
      `);
      expect(result.stdout).toBe("120\n");
    });

    it("should support function keyword syntax", async () => {
      const result = await bash.exec(`
        function greet {
          echo "hi"
        }
        greet
      `);
      expect(result.stdout).toBe("hi\n");
    });

    it("should isolate local variable from outer scope", async () => {
      const result = await bash.exec(`
        outer=global
        myfunc() {
          local outer=local
        }
        myfunc
        echo $outer
      `);
      expect(result.stdout).toBe("global\n");
    });
  });

  // ===========================================================================
  // 8. Error Handling
  // ===========================================================================

  describe("error handling", () => {
    it("should abort with set -e on command failure", async () => {
      const result = await bash.exec(`
        set -e
        true
        false
        echo "should not reach"
      `);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("should not reach");
    });

    it("should not abort without set -e on command failure", async () => {
      const result = await bash.exec(`
        true
        false
        echo "reached"
      `);
      expect(result.stdout).toBe("reached\n");
      expect(result.exitCode).toBe(0);
    });

    it("should run EXIT trap on exit", async () => {
      const result = await bash.exec(`
        trap 'echo cleanup' EXIT
        echo main
      `);
      expect(result.stdout).toBe("main\ncleanup\n");
    });

    it("should run ERR trap on command failure", async () => {
      const result = await bash.exec(`
        trap 'echo "error caught"' ERR
        false
        echo "continued"
      `);
      expect(result.stdout).toContain("error caught");
    });

    it("set -e should not abort in if condition", async () => {
      const result = await bash.exec(`
        set -e
        if false; then
          echo "then"
        else
          echo "else"
        fi
        echo "after"
      `);
      expect(result.stdout).toBe("else\nafter\n");
    });

    it("set -e should not abort in pipeline (non-last)", async () => {
      const result = await bash.exec(`
        set -e
        false | true
        echo "after"
      `);
      expect(result.stdout).toBe("after\n");
    });
  });

  // ===========================================================================
  // 9. Resource Limits
  // ===========================================================================

  describe("resource limits", () => {
    it("should enforce maxCommandCount limit", async () => {
      const limited = new Bash({
        executionLimits: { maxCommandCount: 5 },
      });
      const result = await limited.exec(`
        echo 1; echo 2; echo 3; echo 4; echo 5; echo 6; echo 7; echo 8
      `);
      expect(result.exitCode).toBe(126);
      expect(result.stderr).toContain("too many commands");
    });

    it("should allow execution within maxCommandCount limit", async () => {
      const limited = new Bash({
        executionLimits: { maxCommandCount: 100 },
      });
      const result = await limited.exec("echo hello; echo world");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\nworld\n");
    });

    it("should enforce maxLoopIterations limit", async () => {
      const limited = new Bash({
        executionLimits: { maxLoopIterations: 5 },
      });
      const result = await limited.exec(`
        i=0
        while true; do
          i=$((i + 1))
        done
      `);
      expect(result.exitCode).not.toBe(0);
    });

    it("should enforce maxCallDepth limit on deep recursion", async () => {
      const limited = new Bash({
        executionLimits: { maxCallDepth: 5 },
      });
      const result = await limited.exec(`
        recurse() {
          recurse
        }
        recurse
      `);
      expect(result.exitCode).not.toBe(0);
    });
  });

  // ===========================================================================
  // 10. Logical Operators
  // ===========================================================================

  describe("logical operators", () => {
    it("should short-circuit && on failure", async () => {
      const result = await bash.exec("false && echo never");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
    });

    it("should continue && on success", async () => {
      const result = await bash.exec("true && echo reached");
      expect(result.stdout).toBe("reached\n");
      expect(result.exitCode).toBe(0);
    });

    it("should short-circuit || on success", async () => {
      const result = await bash.exec("true || echo never");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should continue || on failure", async () => {
      const result = await bash.exec("false || echo fallback");
      expect(result.stdout).toBe("fallback\n");
      expect(result.exitCode).toBe(0);
    });

    it("should chain && and || correctly", async () => {
      const result = await bash.exec('true && echo yes || echo no');
      expect(result.stdout).toBe("yes\n");
    });

    it("should chain || then && correctly", async () => {
      const result = await bash.exec('false || echo fallback && echo also');
      expect(result.stdout).toBe("fallback\nalso\n");
    });
  });

  // ===========================================================================
  // 11. Command Substitution
  // ===========================================================================

  describe("command substitution", () => {
    it("should substitute $() result into command", async () => {
      const result = await bash.exec("echo $(echo hello)");
      expect(result.stdout).toBe("hello\n");
    });

    it("should substitute backtick result into command", async () => {
      const result = await bash.exec("echo `echo world`");
      expect(result.stdout).toBe("world\n");
    });

    it("should nest command substitutions", async () => {
      const result = await bash.exec("echo $(echo $(echo nested))");
      expect(result.stdout).toBe("nested\n");
    });

    it("should strip trailing newlines from substitution", async () => {
      const result = await bash.exec('X=$(echo -e "hello\\n\\n"); echo "$X"');
      expect(result.stdout).toBe("hello\n");
    });
  });

  // ===========================================================================
  // 12. Arithmetic
  // ===========================================================================

  describe("arithmetic", () => {
    it("should evaluate arithmetic expansion", async () => {
      const result = await bash.exec("echo $((2 + 3))");
      expect(result.stdout).toBe("5\n");
    });

    it("should evaluate multiplication", async () => {
      const result = await bash.exec("echo $((4 * 5))");
      expect(result.stdout).toBe("20\n");
    });

    it("should evaluate with variables", async () => {
      const result = await bash.exec("x=10; echo $((x + 5))");
      expect(result.stdout).toBe("15\n");
    });

    it("should support comparison in arithmetic", async () => {
      const result = await bash.exec("echo $((5 > 3))");
      expect(result.stdout).toBe("1\n");
    });

    it("should support modulo", async () => {
      const result = await bash.exec("echo $((10 % 3))");
      expect(result.stdout).toBe("1\n");
    });

    it("should support ternary operator", async () => {
      const result = await bash.exec("echo $((1 ? 10 : 20))");
      expect(result.stdout).toBe("10\n");
    });
  });

  // ===========================================================================
  // 13. Here Documents
  // ===========================================================================

  describe("here documents", () => {
    it("should provide heredoc as stdin", async () => {
      const result = await bash.exec(`
cat <<EOF
hello world
EOF
      `);
      expect(result.stdout).toBe("hello world\n");
    });

    it("should expand variables in heredoc", async () => {
      const result = await bash.exec(`
NAME=user
cat <<EOF
hello $NAME
EOF
      `);
      expect(result.stdout).toBe("hello user\n");
    });

    it("should not expand variables in quoted heredoc delimiter", async () => {
      const result = await bash.exec(`
NAME=user
cat <<'EOF'
hello $NAME
EOF
      `);
      // A quoted delimiter (<<'EOF') makes the body fully literal — bash does
      // NOT expand $NAME. (Previously this asserted "hello user\n", encoding a
      // bug where quoted heredocs were expanded like unquoted ones.)
      expect(result.stdout).toBe("hello $NAME\n");
    });
  });
});
