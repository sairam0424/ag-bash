import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

/**
 * A simple command whose words all expand to ZERO fields has an empty argv.
 *
 * POSIX 2.9.1 and bash both treat that as a no-op, NOT as "command not found":
 *   - if there were command substitutions, the status is that of the LAST one;
 *   - otherwise the status is 0;
 *   - variable assignment prefixes affect the CURRENT execution environment
 *     (they are not a temporary frame, because there is no command to run);
 *   - redirections are still performed.
 *
 * Every expectation below was captured from real bash (arm64-darwin) and matches
 * the Oils spec cases in `src/spec-tests/bash/cases/exit-status.test.sh` and
 * `src/spec-tests/bash/cases/strict-options.test.sh`.
 *
 * The distinction that makes this subtle: an UNQUOTED empty expansion produces
 * zero fields (no-op), while a QUOTED empty expansion produces one empty field
 * (a real command named "", i.e. 127 command-not-found).
 */
describe("empty argv is a status-0 no-op, not 127", () => {
  it("runs an unquoted empty variable as a no-op with status 0", async () => {
    const env = new Bash();
    const result = await env.exec(`x=''
$x
echo status=$?`);
    expect(result.stdout).toBe("status=0\n");
    expect(result.stderr).toBe("");
  });

  it("keeps status 0 even when the previous command failed", async () => {
    const env = new Bash();
    const result = await env.exec(`false
x=''
$x
echo status=$?`);
    expect(result.stdout).toBe("status=0\n");
    expect(result.stderr).toBe("");
  });

  it("still reports 127 for a QUOTED empty expansion (one empty field)", async () => {
    const env = new Bash();
    const result = await env.exec(`x=''
"$x"
echo status=$?`);
    expect(result.stdout).toBe("status=127\n");
    expect(result.stderr).toContain("command not found");
  });

  it("uses the status of the last command substitution", async () => {
    const env = new Bash();
    const result = await env.exec(`$(exit 42)
echo status=$?`);
    expect(result.stdout).toBe("status=42\n");
    expect(result.stderr).toBe("");
  });

  it("uses the LAST of several command substitutions", async () => {
    const env = new Bash();
    const result = await env.exec(`$(exit 42) $(exit 43)
echo status=$?`);
    expect(result.stdout).toBe("status=43\n");
    expect(result.stderr).toBe("");
  });

  it("does not let an empty argument change a real command's status", async () => {
    const env = new Bash();
    const result = await env.exec(`true $(false)
echo status=$?`);
    expect(result.stdout).toBe("status=0\n");
  });

  it("treats a backtick substitution with no output as a true condition", async () => {
    const env = new Bash();
    const result = await env.exec(
      "if `true`; then echo TRUE; else echo FALSE; fi",
    );
    expect(result.stdout).toBe("TRUE\n");
    expect(result.exitCode).toBe(0);
  });

  it("propagates a failing backtick substitution to the condition", async () => {
    const env = new Bash();
    const result = await env.exec(
      "if `false`; then echo TRUE; else echo FALSE; fi",
    );
    expect(result.stdout).toBe("FALSE\n");
    expect(result.exitCode).toBe(0);
  });

  it("is FALSE when the substitution produces a word (real command lookup)", async () => {
    const env = new Bash();
    const result = await env.exec(
      "if `echo nosuchcmd_zz`; then echo TRUE; else echo FALSE; fi",
    );
    expect(result.stdout).toBe("FALSE\n");
  });

  it("promotes the first surviving argument to the command name", async () => {
    const env = new Bash();
    const result = await env.exec(`x=''
$x echo hi
echo status=$?`);
    expect(result.stdout).toBe("hi\nstatus=0\n");
    expect(result.stderr).toBe("");
  });

  it("performs redirections on an empty-argv command", async () => {
    const env = new Bash();
    const result = await env.exec(`$(exit 7) > /tmp/empty-argv-redir
echo status=$?
test -f /tmp/empty-argv-redir && echo created`);
    expect(result.stdout).toBe("status=7\ncreated\n");
  });

  it("makes assignment prefixes persist when argv is empty", async () => {
    const env = new Bash();
    const result = await env.exec(`x=''
FOO=bar $x
echo status=$? FOO=$FOO`);
    expect(result.stdout).toBe("status=0 FOO=bar\n");
  });

  it("clears $_ for an empty-argv command", async () => {
    const env = new Bash();
    const result = await env.exec(`echo hello
x=''
$x
echo "underscore=[$_]"`);
    expect(result.stdout).toBe("hello\nunderscore=[]\n");
  });

  it("honours errexit when the last command substitution failed", async () => {
    const env = new Bash();
    const result = await env.exec(`set -e
$(exit 5)
echo reached`);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(5);
  });
});
