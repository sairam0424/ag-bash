/**
 * `{var}>file` allocates a descriptor and stores its number in `var`. When the
 * file cannot be opened bash fails the command, leaves `var` as it was and
 * keeps no descriptor. Expected results below were checked against bash 5.3.
 *
 * Before the fix `processFdVariableRedirections()` created the file without
 * looking at it: a missing parent made exec() reject with ENOENT, and a
 * directory target was silently replaced by an empty regular file.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("{var}> redirections that cannot be opened", () => {
  it("fails with the missing-parent message and leaves the variable unset", async () => {
    const env = new Bash();
    const result = await env.exec(
      'exec {fd}> nodir/f; echo "rc=$? fd=${fd-unset}"',
    );
    expect(result.stdout).toBe("rc=1 fd=unset\n");
    expect(result.stderr).toBe("bash: nodir/f: No such file or directory\n");
  });

  it("keeps the variable's previous value", async () => {
    const env = new Bash();
    const result = await env.exec(
      'fd=5; exec {fd}> nodir/f; echo "rc=$? fd=$fd"',
    );
    expect(result.stdout).toBe("rc=1 fd=5\n");
  });

  it("does not leak the descriptor it had allocated", async () => {
    const env = new Bash();
    const result = await env.exec(
      'mkdir okdir; exec {a}> nodir/f; exec {b}> okdir/f; echo "a=${a-unset} b=$b"',
    );
    expect(result.stdout).toBe("a=unset b=10\n");
  });

  it("keeps earlier descriptors of the same command and stops at the failing one", async () => {
    const env = new Bash();
    const result = await env.exec(
      'mkdir okdir; exec {a}> okdir/f1 {b}> nodir/f; echo "rc=$? a=${a-unset} b=${b-unset}"',
    );
    expect(result.stdout).toBe("rc=1 a=10 b=unset\n");
  });

  it("reports a parent that is a file", async () => {
    const env = new Bash();
    await env.exec("echo data > afile");
    const result = await env.exec("exec {fd}> afile/f");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("bash: afile/f: Not a directory\n");
  });

  it("does not replace a directory with a file", async () => {
    const env = new Bash();
    await env.exec("mkdir adir");
    const result = await env.exec(
      'exec {fd}> adir; echo "rc=$? fd=${fd-unset}"',
    );
    expect(result.stdout).toBe("rc=1 fd=unset\n");
    expect(result.stderr).toBe("bash: adir: Is a directory\n");
    const probe = await env.exec("test -d adir");
    expect(probe.exitCode).toBe(0);
  });

  it.each([
    [
      "{fd}>> with a missing parent",
      "exec {fd}>> nodir/f",
      "No such file or directory",
    ],
    ["{fd}>> with a file as parent", "exec {fd}>> afile/f", "Not a directory"],
    ["{fd}>> on a directory", "exec {fd}>> adir", "Is a directory"],
    [
      "{fd}&> with a missing parent",
      "exec {fd}&> nodir/f",
      "No such file or directory",
    ],
    [
      "{fd}>| with a missing parent",
      "exec {fd}>| nodir/f",
      "No such file or directory",
    ],
  ])("%s", async (_name, script, message) => {
    const env = new Bash();
    await env.exec("echo data > afile; mkdir adir");
    const result = await env.exec(`${script}; echo "rc=$? fd=\${fd-unset}"`);
    expect(result.stdout).toBe("rc=1 fd=unset\n");
    expect(result.stderr).toContain(message);
  });

  it("fails an ordinary command and a group the same way", async () => {
    const env = new Bash();
    const command = await env.exec(
      'echo hi {fd}> nodir/f; echo "rc=$? fd=${fd-unset}"',
    );
    expect(command.stdout).toBe("rc=1 fd=unset\n");
    expect(command.stderr).toBe("bash: nodir/f: No such file or directory\n");

    const group = await env.exec(
      '{ echo hi; } {fd}> nodir/f; echo "rc=$? fd=${fd-unset}"',
    );
    expect(group.stdout).toBe("rc=1 fd=unset\n");
    expect(group.stderr).toBe("bash: nodir/f: No such file or directory\n");
  });

  it("honours noclobber, and >| overrides it", async () => {
    const env = new Bash();
    await env.exec("echo data > afile");
    const refused = await env.exec(
      'set -C; exec {fd}> afile; echo "rc=$? fd=${fd-unset}"',
    );
    expect(refused.stdout).toBe("rc=1 fd=unset\n");
    expect(refused.stderr).toContain("cannot overwrite existing file");

    const forced = await env.exec('exec {fd}>| afile; echo "rc=$? fd=$fd"');
    expect(forced.stdout).toBe("rc=0 fd=10\n");
  });

  it("still opens and writes through a usable target", async () => {
    const env = new Bash();
    const result = await env.exec(
      'mkdir okdir; exec {fd}> okdir/f; echo hi >&$fd; cat okdir/f; echo "fd=$fd"',
    );
    expect(result.stdout).toBe("hi\nfd=10\n");
    expect(result.stderr).toBe("");
  });
});

describe("{var}>| and {var}>> under noclobber", () => {
  // bash allows both over an existing file: >| overrides noclobber and >>
  // never truncates, so noclobber has nothing to protect.
  it("{fd}>| truncates the file and opens it", async () => {
    const env = new Bash();
    const result = await env.exec(
      'echo old > existing; set -C; exec {fd}>| existing; echo "rc=$? fd=${fd-unset} file=[$(cat existing)]"; echo hi >&$fd; echo "[$(cat existing)]"',
    );
    expect(result.stdout).toBe("rc=0 fd=10 file=[]\n[hi]\n");
    expect(result.stderr).toBe("");
  });

  it("{fd}>> keeps the file's content and appends to it", async () => {
    const env = new Bash();
    const result = await env.exec(
      'echo old > existing; set -C; exec {fd}>> existing; echo "rc=$? fd=${fd-unset} file=[$(cat existing)]"; echo hi >&$fd; cat existing',
    );
    expect(result.stdout).toBe("rc=0 fd=10 file=[old]\nold\nhi\n");
    expect(result.stderr).toBe("");
  });

  it("{fd}&>> keeps the file's content too", async () => {
    const env = new Bash();
    const result = await env.exec(
      'echo old > existing; set -C; exec {fd}&>> existing; echo "rc=$? fd=${fd-unset} file=[$(cat existing)]"',
    );
    expect(result.stdout).toBe("rc=0 fd=10 file=[old]\n");
    expect(result.stderr).toBe("");
  });
});
