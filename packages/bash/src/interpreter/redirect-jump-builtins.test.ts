/**
 * `break`, `continue`, `return` and `exit` jump by throwing inside the
 * interpreter, so their redirections are opened separately from the normal
 * path. When one of those redirections cannot be opened bash reports the
 * error and does NOT perform the jump (the command never ran). Expected
 * output below was checked against bash 5.3.
 *
 * Before the fix `exit 3 > /nonexistent/f` made exec() reject with ENOENT
 * (the same unchecked pre-truncation as the fuzz counterexample), and
 * `break > /nonexistent/f` / `return > /nonexistent/f` surfaced a raw
 * `ENOENT: ...` string as stderr.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { ReadWriteFs } from "../fs/read-write-fs/read-write-fs.js";

describe("jump builtins with a redirection that cannot be opened", () => {
  it("break is not performed", async () => {
    const env = new Bash();
    const result = await env.exec(
      "for i in 1 2 3; do echo $i; break > nodir/f; done; echo end",
    );
    expect(result.stdout).toBe("1\n2\n3\nend\n");
    expect(result.stderr).toBe(
      "bash: nodir/f: No such file or directory\n".repeat(3),
    );
  });

  it("continue is not performed", async () => {
    const env = new Bash();
    const result = await env.exec(
      'for i in 1 2; do continue > nodir/f; echo "after-continue $i"; done',
    );
    expect(result.stdout).toBe("after-continue 1\nafter-continue 2\n");
    expect(result.stderr).toBe(
      "bash: nodir/f: No such file or directory\n".repeat(2),
    );
  });

  it("return is not performed", async () => {
    const env = new Bash();
    const result = await env.exec(
      'f() { return 3 > nodir/f; echo "after-return"; }; f; echo "rc=$?"',
    );
    expect(result.stdout).toBe("after-return\nrc=0\n");
    expect(result.stderr).toBe("bash: nodir/f: No such file or directory\n");
  });

  it("exit is not performed, and exec() does not reject", async () => {
    const env = new Bash();
    const result = await env.exec("exit 3 > nodir/f; echo notexited");
    expect(result.stdout).toBe("notexited\n");
    expect(result.stderr).toBe("bash: nodir/f: No such file or directory\n");
  });

  it("a directory target stops the jump too", async () => {
    const env = new Bash();
    const result = await env.exec("mkdir d; exit 3 > d; echo notexited");
    expect(result.stdout).toBe("notexited\n");
    expect(result.stderr).toBe("bash: d: Is a directory\n");
  });

  it("still jumps, and still creates the file, when the redirection opens", async () => {
    const env = new Bash();
    const looped = await env.exec(
      "for i in 1 2; do echo $i; break > made; done; echo end",
    );
    expect(looped.stdout).toBe("1\nend\n");
    expect(looped.stderr).toBe("");
    const probe = await env.exec("test -f made");
    expect(probe.exitCode).toBe(0);

    const exited = await env.exec("exit 3 > /dev/null; echo notreached");
    expect(exited.exitCode).toBe(3);
    expect(exited.stdout).toBe("");
  });

  // The jump that was not performed is a failed command: `$?` is 1 whatever
  // status the builtin was given (`return 3`, `exit 3`).
  it.each([
    [
      "break",
      'for i in 1; do break > nodir/f; echo "rc=$?"; done',
      "rc=1\n",
      "bash: nodir/f: No such file or directory\n",
    ],
    [
      "continue",
      'for i in 1 2; do continue > nodir/f; echo "rc=$?"; done',
      "rc=1\nrc=1\n",
      "bash: nodir/f: No such file or directory\n".repeat(2),
    ],
    [
      "return",
      'f() { return 3 > nodir/f; echo "rc=$?"; }; f',
      "rc=1\n",
      "bash: nodir/f: No such file or directory\n",
    ],
    [
      "exit",
      'exit 3 > nodir/f; echo "rc=$?"',
      "rc=1\n",
      "bash: nodir/f: No such file or directory\n",
    ],
    [
      "exit with a directory target",
      'mkdir d; exit 3 > d; echo "rc=$?"',
      "rc=1\n",
      "bash: d: Is a directory\n",
    ],
    [
      "break refused by noclobber",
      'echo old > e; set -C; for i in 1; do break > e; echo "rc=$?"; done',
      "rc=1\n",
      "bash: e: cannot overwrite existing file\n",
    ],
  ])("%s sets $? to 1", async (_name, script, stdout, stderr) => {
    const env = new Bash();
    const result = await env.exec(script);
    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe(stderr);
  });

  it("a failed last-line exit ends the script with status 1, not 3", async () => {
    const env = new Bash();
    const result = await env.exec("exit 3 > nodir/f");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("bash: nodir/f: No such file or directory\n");
  });
});

interface JumpCase {
  readonly name: string;
  readonly script: string;
  readonly stdout: string;
  readonly exitCode: number;
}

/**
 * Jump builtins whose redirections DO open: the jump must still happen.
 *
 * `{fd}> file` is opened once, before the command runs; the jump handler must
 * not open it a second time (under `set -C` the second open is refused because
 * the first one created the file). `/dev/full` opens fine, only writing to it
 * fails, and the jump builtins write nothing. Expectations checked against
 * bash 5.3 (the `/dev/full` ones against the same semantics: opening succeeds).
 */
const MUST_STILL_JUMP: readonly JumpCase[] = [
  {
    name: "break with {fd}> under noclobber",
    script:
      'set -C; for i in 1 2; do echo $i; break {fd}> newfile; done; echo "rc=$?"',
    stdout: "1\nrc=0\n",
    exitCode: 0,
  },
  {
    name: "exit with {fd}> under noclobber",
    script: "set -C; exit 3 {fd}> newfile; echo notexited",
    stdout: "",
    exitCode: 3,
  },
  {
    name: "return with {fd}> under noclobber",
    script: 'set -C; f() { return 3 {fd}> newfile; echo no; }; f; echo "rc=$?"',
    stdout: "rc=3\n",
    exitCode: 0,
  },
  {
    name: "exit with {fd}> in a subshell under noclobber",
    script: 'set -C; (exit 3 {fd}> newfile); echo "rc=$?"',
    stdout: "rc=3\n",
    exitCode: 0,
  },
  {
    name: "exit to /dev/full",
    script: "exit 3 > /dev/full; echo notreached",
    stdout: "",
    exitCode: 3,
  },
  {
    name: "break to /dev/full",
    script: "for i in 1 2; do echo $i; break > /dev/full; done",
    stdout: "1\n",
    exitCode: 0,
  },
  {
    name: "return to /dev/full",
    script: 'f() { return 3 > /dev/full; echo no; }; f; echo "rc=$?"',
    stdout: "rc=3\n",
    exitCode: 0,
  },
];

describe("jump builtins whose redirections open still jump", () => {
  describe("on the default in-memory filesystem", () => {
    it.each(MUST_STILL_JUMP)("$name", async (c) => {
      const env = new Bash();
      try {
        const result = await env.exec(c.script);
        expect({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }).toEqual({ stdout: c.stdout, stderr: "", exitCode: c.exitCode });
      } finally {
        env.destroy();
      }
    });
  });

  describe("on a ReadWriteFs over an empty root", () => {
    let rootDir: string;

    beforeEach(() => {
      rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "redirect-jump-"));
    });

    afterEach(() => {
      fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it.each(MUST_STILL_JUMP)("$name", async (c) => {
      const env = new Bash({
        fs: new ReadWriteFs({ root: rootDir }),
        cwd: "/",
      });
      try {
        const result = await env.exec(c.script);
        expect({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }).toEqual({ stdout: c.stdout, stderr: "", exitCode: c.exitCode });
      } finally {
        env.destroy();
      }
    });
  });
});
