import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

/**
 * `--` is the end-of-options marker for `alias` and `unalias`.
 *
 * Everything after it is an operand, even if it starts with `-`. It is NOT
 * itself an alias name, so `alias -- foo=echo` must define `foo` silently with
 * status 0 rather than complaining that the alias `--` does not exist.
 *
 * Oracle: real bash 3.2.57 (arm64-apple-darwin), captured directly --
 *
 *   $ alias -- foo=echo; echo status=$?          -> status=0, no stderr
 *   $ unalias -- foo; echo status=$?             -> status=0, no stderr
 *   $ alias a=b; alias --                        -> alias a='b'   (lists, like bare `alias`)
 *   $ unalias --; echo st=$?                     -> usage error, st=2
 *   $ alias -- -x=echo; alias                    -> alias -x='echo'
 *   $ unalias -- nosuch; echo st=$?              -> "not found", st=1
 *
 * This is the oracle for the Oils spec case
 * `src/spec-tests/bash/cases/alias.test.sh::Usage of builtins`, which failed
 * with `bash: alias: --: not found` / `bash: unalias: --: not found`.
 */
describe("alias/unalias honour the -- end-of-options marker", () => {
  it("defines an alias after -- with status 0 and no stderr", async () => {
    const env = new Bash();
    const result = await env.exec(`shopt -s expand_aliases
alias -- foo=echo
echo status=$?
foo x`);
    expect(result.stdout).toBe("status=0\nx\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("removes an alias after -- with status 0 and no stderr", async () => {
    const env = new Bash();
    const result = await env.exec(`shopt -s expand_aliases
alias -- foo=echo
unalias -- foo
echo status=$?`);
    expect(result.stdout).toBe("status=0\n");
    expect(result.stderr).toBe("");
  });

  it("makes the alias unusable again after unalias --", async () => {
    const env = new Bash();
    const result = await env.exec(`shopt -s expand_aliases
alias -- foo=echo
foo x
unalias -- foo
foo x`);
    expect(result.stdout).toBe("x\n");
    expect(result.stderr).toContain("foo: command not found");
    expect(result.exitCode).toBe(127);
  });

  it("lists all aliases when -- is the only argument", async () => {
    const env = new Bash();
    const result = await env.exec(`alias a=b
alias --
echo status=$?`);
    expect(result.stdout).toBe("alias a='b'\nstatus=0\n");
    expect(result.stderr).toBe("");
  });

  it("allows an alias name that starts with a dash after --", async () => {
    const env = new Bash();
    const result = await env.exec(`alias -- -x=echo
echo status=$?
alias`);
    expect(result.stdout).toBe("status=0\nalias -x='echo'\n");
    expect(result.stderr).toBe("");
  });

  it("reports a usage error for unalias with only --", async () => {
    const env = new Bash();
    const result = await env.exec("unalias --\necho st=$?");
    expect(result.stdout).toBe("st=2\n");
    expect(result.stderr).toContain("unalias: usage:");
  });

  it("still reports a missing alias named after --", async () => {
    const env = new Bash();
    const result = await env.exec("unalias -- nosuch\necho st=$?");
    expect(result.stdout).toBe("st=1\n");
    expect(result.stderr).toBe("bash: unalias: nosuch: not found\n");
  });

  it("still reports a missing alias for a bare query without --", async () => {
    const env = new Bash();
    const result = await env.exec("alias nosuch\necho st=$?");
    expect(result.stdout).toBe("st=1\n");
    expect(result.stderr).toBe("bash: alias: nosuch: not found\n");
  });
});
