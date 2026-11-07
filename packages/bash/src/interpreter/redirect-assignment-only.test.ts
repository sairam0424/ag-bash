/**
 * Assignment-only commands (and other commands with no command word) that
 * carry an output redirection to an unusable path.
 *
 * Regression for the long-fuzz counterexample "combined malformed" (seed
 * 1736057820, run 7094 of `fc.sample(malformedScript, ...)`): the redirect
 * target was a path whose parent directory does not exist, and exec() rejected
 * with `ENOENT: no such file or directory, open ...` instead of failing the
 * command the way bash does. The command-less branch of the simple-command
 * interpreter pre-truncates redirect targets with preOpenOutputRedirects(),
 * which never checked the parent directory.
 *
 * Behaviour below was checked against real bash 5.3: the assignment is still
 * performed, `$?` is 1, the message goes to stderr and the script goes on.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

/**
 * The script generated for run 7094. The byte after `>` is U+009C (injected by
 * the fuzzer's byte-injection category), which makes the redirect target a
 * relative path whose first component does not exist.
 */
const FUZZ_COUNTEREXAMPLE =
  '[[ -d {ydl1N,8.K-4gXj} ]] || __proto__=>\u009c/"hhC${propertyIsEnumerable:-grKBdL}" | hasOwnProperty=0XZ6\n' +
  "! DKU[toString]=${#constructor}\n" +
  'prototype="TZ/q42V$((rETgnjl_v ? 480 : 387))"';

describe("assignment-only command with a failing output redirection", () => {
  it("fails with bash's message instead of rejecting (minimal repro)", async () => {
    const env = new Bash();
    const result = await env.exec("x=1 > /nonexistent/f");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "bash: /nonexistent/f: No such file or directory\n",
    );
  });

  it("does not reject for the exact script from fuzz run 7094", async () => {
    const env = new Bash();
    const result = await env.exec(FUZZ_COUNTEREXAMPLE);
    expect(typeof result.exitCode).toBe("number");
    expect(result.stderr).toContain("No such file or directory");
  });

  it("names a parent that is a file", async () => {
    const env = new Bash();
    await env.exec("echo data > afile");
    const result = await env.exec("x=1 > afile/child");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("bash: afile/child: Not a directory\n");
  });

  it("names a directory target", async () => {
    const env = new Bash();
    await env.exec("mkdir adir");
    const result = await env.exec("x=1 > adir");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("bash: adir: Is a directory\n");
  });

  it("still performs the assignment and sets $? to 1, like bash", async () => {
    const env = new Bash();
    const result = await env.exec('x=1 > nodir/f; echo "rc=$? x=${x-unset}"');
    expect(result.stdout).toBe("rc=1 x=1\n");
    expect(result.stderr).toBe("bash: nodir/f: No such file or directory\n");
  });

  it("performs every assignment, including arrays and command substitutions", async () => {
    const env = new Bash();
    const result = await env.exec(
      'x=$(echo hi) y=2 a=(1 2) > nodir/f; echo "rc=$? x=$x y=$y a=${a[*]}"',
    );
    expect(result.stdout).toBe("rc=1 x=hi y=2 a=1 2\n");
  });

  it("a bare redirection fails the same way", async () => {
    const env = new Bash();
    const result = await env.exec('> nodir/f; echo "rc=$?"');
    expect(result.stdout).toBe("rc=1\n");
    expect(result.stderr).toBe("bash: nodir/f: No such file or directory\n");
  });

  it("does not create the missing parent directory or the file", async () => {
    const env = new Bash();
    await env.exec("x=1 > nodir/f");
    const probe = await env.exec("test ! -e nodir && test ! -e nodir/f");
    expect(probe.exitCode).toBe(0);
  });

  it("keeps files opened by earlier redirections and stops at the failing one", async () => {
    const env = new Bash();
    const result = await env.exec("x=1 > made > nodir/f > never");
    expect(result.exitCode).toBe(1);
    const probe = await env.exec("test -f made && test ! -e never");
    expect(probe.exitCode).toBe(0);
  });

  it("lets the script continue with the next command", async () => {
    const env = new Bash();
    const result = await env.exec("x=1 > nodir/f; echo after");
    expect(result.stdout).toBe("after\n");
    expect(result.exitCode).toBe(0);
  });

  it("is a failure for && / || and for set -e", async () => {
    const env = new Bash();
    const chained = await env.exec("x=1 > nodir/f && echo yes || echo no");
    expect(chained.stdout).toBe("no\n");

    const strict = await env.exec('set -e; x=1 > nodir/f; echo "not reached"');
    expect(strict.stdout).toBe("");
    expect(strict.exitCode).toBe(1);
  });

  it("fires the ERR trap", async () => {
    const env = new Bash();
    const result = await env.exec(
      'trap "echo ERR" ERR; x=1 > nodir/f; echo after',
    );
    expect(result.stdout).toBe("ERR\nafter\n");
  });

  it("works inside a function, a command substitution and a pipeline", async () => {
    const env = new Bash();
    const inFunction = await env.exec(
      'f() { y=1 > nodir/f; echo "rc=$? y=$y"; }; f',
    );
    expect(inFunction.stdout).toBe("rc=1 y=1\n");

    const inSubstitution = await env.exec(
      'v=$(w=1 > nodir/f; echo "rc=$?"); echo "[$v]"',
    );
    expect(inSubstitution.stdout).toBe("[rc=1]\n");
    expect(inSubstitution.stderr).toContain("No such file or directory");

    const inPipeline = await env.exec(
      'z=1 > nodir/f | cat; echo "${PIPESTATUS[*]}"',
    );
    expect(inPipeline.stdout).toBe("1 0\n");
  });

  it("noclobber and clobber behave as before", async () => {
    const env = new Bash();
    await env.exec("echo old > existing");
    const refused = await env.exec('set -C; x=1 > existing; echo "rc=$?"');
    expect(refused.stdout).toBe("rc=1\n");
    expect(refused.stderr).toBe(
      "bash: existing: cannot overwrite existing file\n",
    );

    const clobbered = await env.exec("x=1 >| existing; echo rc=$?");
    expect(clobbered.stdout).toBe("rc=0\n");

    const missing = await env.exec("x=1 >| nodir/f; echo rc=$?");
    expect(missing.stdout).toBe("rc=1\n");
    expect(missing.stderr).toBe("bash: nodir/f: No such file or directory\n");
  });

  it("still creates the file when the parent exists", async () => {
    const env = new Bash();
    await env.exec("mkdir okdir");
    const result = await env.exec("x=1 > okdir/f; echo rc=$?");
    expect(result.stdout).toBe("rc=0\n");
    const probe = await env.exec("test -f okdir/f");
    expect(probe.exitCode).toBe(0);
  });
});
