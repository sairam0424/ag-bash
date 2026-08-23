/**
 * Numbered / duplicated file descriptors.
 *
 * `applyRedirections()` only ever tracked numeric fds >= 3 for the OUTPUT
 * operators (`>`, `>|`). Four shapes that real bash supports were silently
 * dropped, so the fd was reported as closed the moment anything referenced it:
 *
 *   - `exec N>&M`  — duplicate an already-open descriptor onto N
 *   - `exec N<file` — open a file for reading on N
 *   - `exec N<>file` — open a file for read/write on N
 *   - `cmd <&N`     — dup N onto STDIN (the operator defaulted to fd 1, i.e.
 *                     it was treated as an *output* dup, which then reported
 *                     "Bad file descriptor" for a perfectly valid input fd)
 *
 * Every expectation below was captured from /bin/bash on this machine; the
 * exact scripts come from the Oils `redirect.test.sh` conformance cases
 * ("Open descriptor with exec", "Open multiple descriptors with exec", "<&",
 * "<> for read/write").
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("exec N>&M duplicates an open descriptor", () => {
  it("`exec 3>&1` makes fd 3 an alias for stdout", async () => {
    // /bin/bash: `exec 3>&1; echo hi 1>&3` -> "hi"
    const bash = new Bash();
    const result = await bash.exec("exec 3>&1\necho hi 1>&3");

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
  });

  it("`exec 3>&1; exec 4>&1` opens both descriptors", async () => {
    // /bin/bash: prints "three" then "four"
    const bash = new Bash();
    const result = await bash.exec(
      "exec 3>&1\nexec 4>&1\necho three 1>&3\necho four 1>&4",
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("three\nfour\n");
  });

  it("`>&3` with no explicit source fd writes through the dup", async () => {
    // /bin/bash: `exec 3>&1; echo x >&3; echo done` -> "x\ndone"
    const bash = new Bash();
    const result = await bash.exec("exec 3>&1\necho x >&3\necho done");

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("x\ndone\n");
  });

  it("`exec 4>&3` chains a dup off a file-backed descriptor", async () => {
    // /bin/bash: both lines land in the file
    const bash = new Bash();
    const result = await bash.exec(
      "exec 3> /out.txt\nexec 4>&3\necho a >&3\necho b >&4\ncat /out.txt",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("a\nb\n");
  });

  it("`exec 3>&9` on a closed source fd reports Bad file descriptor", async () => {
    // /bin/bash: "bash: 9: Bad file descriptor", $? == 1
    const bash = new Bash();
    const result = await bash.exec("exec 3>&9\necho after=$?");

    expect(result.stderr).toContain("9: Bad file descriptor");
    expect(result.stdout).toBe("after=1\n");
  });
});

describe("exec N<file opens a numbered descriptor for reading", () => {
  it("`exec 6< file` then `read line <&6` reads the file", async () => {
    // /bin/bash: `echo foo51 > f; exec 6< f; read line <&6; echo "[$line]"`
    //            -> "[foo51]"
    const bash = new Bash();
    const result = await bash.exec(
      'echo foo51 > /lessamp.txt\nexec 6< /lessamp.txt\nread line <&6\necho "[$line]"',
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[foo51]\n");
  });

  it("`exec 6< missing` fails and leaves fd 6 closed", async () => {
    // /bin/bash: "No such file or directory", then reading <&6 is a bad fd
    const bash = new Bash();
    const result = await bash.exec("exec 6< /nope.txt");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("No such file or directory");
  });
});

describe("exec N<>file opens a numbered descriptor for read/write", () => {
  it("reads the existing contents and then writes through the same fd", async () => {
    // /bin/bash:
    //   echo first > rw.txt; exec 8<>rw.txt; read line <&8; echo line=$line
    //   echo second 1>&8; echo CONTENTS; cat rw.txt
    // -> "line=first\nCONTENTS\nfirst\nsecond"
    const bash = new Bash();
    const result = await bash.exec(
      [
        "echo first >/rw.txt",
        "exec 8<>/rw.txt",
        "read line <&8",
        "echo line=$line",
        "echo second 1>&8",
        "echo CONTENTS",
        "cat /rw.txt",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("line=first\nCONTENTS\nfirst\nsecond\n");
  });

  it("creates the file when it does not exist and does not truncate it", async () => {
    // /bin/bash: `exec 8<>brandnew.txt; echo w >&8; cat brandnew.txt` -> "w"
    const bash = new Bash();
    const result = await bash.exec(
      "exec 8<>/brandnew.txt\necho w >&8\ncat /brandnew.txt",
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("w\n");
  });
});

describe("regressions that must keep holding", () => {
  it("`echo hi 1>&7` on a never-opened fd is still Bad file descriptor", async () => {
    // /bin/bash: "bash: 7: Bad file descriptor", $? == 1
    const bash = new Bash();
    const result = await bash.exec("echo hi 1>&7\necho st=$?");

    expect(result.stderr).toContain("7: Bad file descriptor");
    expect(result.stdout).toBe("st=1\n");
  });

  it("maxFileDescriptors is still enforced for numeric `exec N>` fds", async () => {
    const bash = new Bash({ executionLimits: { maxFileDescriptors: 5 } });
    const result = await bash.exec(
      "exec 3>/dev/null; exec 4>/dev/null; exec 5>/dev/null; exec 6>/dev/null; exec 7>/dev/null; exec 8>/dev/null",
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("file descriptors");
  });

  it("maxFileDescriptors is enforced for numeric `exec N>&M` dups too", async () => {
    const bash = new Bash({ executionLimits: { maxFileDescriptors: 4 } });
    const result = await bash.exec(
      "exec 3>&1; exec 4>&1; exec 5>&1; exec 6>&1; exec 7>&1; exec 8>&1",
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("file descriptors");
  });

  it("`1<&2` (explicit fd) still routes stdout to stderr", async () => {
    // /bin/bash: `echo one 1>&2; echo two 1<&2` -> both on stderr
    const bash = new Bash();
    const result = await bash.exec("echo one 1>&2\necho two 1<&2");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("one\ntwo\n");
  });

  it("`2>&1` still folds stderr into stdout", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo err 1>&2 2>&1");

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("err\n");
  });
});
