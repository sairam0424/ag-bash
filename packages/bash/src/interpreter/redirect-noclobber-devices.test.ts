/**
 * Edges of the `noclobber` exemption for device files.
 *
 * Under `set -C` bash refuses to overwrite an existing regular file, but not a
 * device. The default filesystem models `/dev/null`, `/dev/zero`,
 * `/dev/stdin`, `/dev/stdout` and `/dev/stderr` as ordinary in-memory files, so
 * `checkOutputRedirectTarget()` exempts them by name (`DEVICE_FILE` in
 * redirections.ts). The name test has to be exact: anchored at both ends, and
 * limited to the listed names. These tests pin the places where a looser test
 * would exempt a regular file, and the places where a tighter one would refuse
 * a device, on the default in-memory filesystem.
 *
 * Every expectation was checked against bash 5.2.15 on Linux (a Debian
 * bookworm container, stdin `/dev/null`, stdout and stderr pipes). Rows that
 * pin ag-bash behaviour rather than bash's say so:
 *
 * - `/dev/stdout` and `/dev/stderr` are exempt here, as in Linux bash while
 *   fd 1 / fd 2 is a pipe or a tty. Bash refuses them when the descriptor is a
 *   regular file, and macOS bash 5.3 refuses even for a pipe.
 * - `/dev/stdin` is exempt here, as in Linux bash while fd 0 is not a regular
 *   file (it is refused when stdin is redirected from a file).
 * - `{fd}>` to a file that is refused names the path in the message here; bash
 *   names the variable (`bash: fd: cannot overwrite existing file`). Only the
 *   common part of the message is asserted.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Runs one script on a fresh default (in-memory) shell. */
async function run(script: string): Promise<Outcome> {
  const env = new Bash();
  try {
    const result = await env.exec(script);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } finally {
    env.destroy();
  }
}

describe("noclobber and /dev/null", () => {
  // The commonest case: silencing a command in a script that sets `set -C`.
  it("echo hi > /dev/null succeeds with status 0", async () => {
    expect(await run("set -C; echo hi > /dev/null")).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  // `2>` leaves the echoed text on stdout; every other form discards it.
  it.each([
    ["stdout", "echo hi > /dev/null", "rc=0\n"],
    ["stderr", "echo hi 2> /dev/null", "hi\nrc=0\n"],
    ["both, with &>", "echo hi &> /dev/null", "rc=0\n"],
    ["both, with >&", "echo hi >& /dev/null", "rc=0\n"],
    ["a subshell", "( echo hi ) > /dev/null", "rc=0\n"],
    ["a path spelled with ./", "echo hi > /dev/./null", "rc=0\n"],
    ["a path spelled with //", "echo hi > /dev//null", "rc=0\n"],
    [
      "a path that reaches it through ..",
      "echo hi > /tmp/../dev/null",
      "rc=0\n",
    ],
  ])("%s", async (_name, command, stdout) => {
    expect(await run(`set -C; ${command}; echo "rc=$?"`)).toEqual({
      stdout,
      stderr: "",
      exitCode: 0,
    });
  });
});

describe("noclobber and /dev/stdout, /dev/stderr with &>", () => {
  // ag-bash behaviour, see the header: Linux bash agrees while the descriptor
  // is a pipe or a tty, macOS bash 5.3 does not.
  it.each([
    "/dev/stdout",
    "/dev/stderr",
  ])(": &> %s succeeds", async (device) => {
    expect(await run(`set -C; : &> ${device}; echo "rc=$?"`)).toEqual({
      stdout: "rc=0\n",
      stderr: "",
      exitCode: 0,
    });
  });
});

describe("noclobber still protects a regular file that only looks like a device", () => {
  interface LookAlike {
    readonly name: string;
    /** Directory that holds the file; it is created if it is missing. */
    readonly dir: string;
    /** The path used in the redirection, absolute or relative to /home/user. */
    readonly path: string;
  }

  const LOOK_ALIKES: readonly LookAlike[] = [
    // The device name at the end of a longer path (an unanchored start).
    {
      name: "dev/null below the home directory",
      dir: "/home/user/dev",
      path: "/home/user/dev/null",
    },
    {
      name: "dev/null below the working directory",
      dir: "/home/user/dev",
      path: "dev/null",
    },
    {
      name: "dev/null below /tmp",
      dir: "/tmp/dev",
      path: "/tmp/dev/null",
    },
    // The device name at the start of a longer name (an unanchored end).
    { name: "/dev/nullx", dir: "/dev", path: "/dev/nullx" },
    { name: "/dev/xnull", dir: "/dev", path: "/dev/xnull" },
    { name: "/devfile", dir: "/", path: "/devfile" },
    // A regular file under /dev, with and without a device name.
    { name: "/dev/shm/x", dir: "/dev/shm", path: "/dev/shm/x" },
    { name: "/dev/shm/null", dir: "/dev/shm", path: "/dev/shm/null" },
  ];

  const FORMS: ReadonlyArray<readonly [string, string]> = [
    ["a simple command", "echo new > %s"],
    ["exec {fd}>", "exec {fd}> %s"],
  ];

  describe.each(FORMS)("through %s", (_form, template) => {
    it.each(LOOK_ALIKES)("$name", async ({ dir, path }) => {
      const result = await run(
        `cd /home/user; mkdir -p ${dir}; echo old > ${path}; set -C; ` +
          `${template.replace("%s", path)}; ` +
          `echo "rc=$? [$(cat ${path})]"`,
      );
      expect(result.stdout).toBe("rc=1 [old]\n");
      expect(result.stderr).toContain("cannot overwrite existing file");
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("noclobber exempts every device name the filesystem can hold", () => {
  // The names the default filesystem creates under /dev (checked below with
  // `test -e`, so a missing file cannot make the row pass for the wrong reason).
  // The /dev/stdin, /dev/stdout and /dev/stderr rows pin ag-bash behaviour, see
  // the header.
  const DEFAULT_DEVICES = [
    "/dev/null",
    "/dev/zero",
    "/dev/stdin",
    "/dev/stdout",
    "/dev/stderr",
  ] as const;

  it.each(DEFAULT_DEVICES)("%s", async (device) => {
    expect(
      await run(
        `test -e ${device} && echo present; set -C; : > ${device}; echo "rc=$?"`,
      ),
    ).toEqual({ stdout: "present\nrc=0\n", stderr: "", exitCode: 0 });
  });

  // The rest of the allowlist is not in the default filesystem. A host-backed
  // or custom filesystem supplies those files, so the test creates an ordinary
  // file under each name, as the default filesystem does for the five above.
  // Bash agrees (checked with a pty for /dev/tty): none of them is refused.
  it.each([
    "/dev/tty",
    "/dev/random",
    "/dev/urandom",
  ])("%s, supplied as a file", async (device) => {
    expect(
      await run(
        `touch ${device}; set -C; exec {fd}> ${device}; echo "rc=$? fd=\${fd-unset}"`,
      ),
    ).toEqual({ stdout: "rc=0 fd=10\n", stderr: "", exitCode: 0 });
  });

  // The exact spelling `/dev/full` never reaches the noclobber check (it is
  // answered with ENOSPC, or skipped, before the target is looked at), so
  // /dev/full is reached through a relative path. `:` writes nothing, so the
  // redirect succeeds in bash and here.
  it("/dev/full, supplied as a file, through a relative path", async () => {
    expect(
      await run('touch /dev/full; set -C; cd /dev; : > full; echo "rc=$?"'),
    ).toEqual({ stdout: "rc=0\n", stderr: "", exitCode: 0 });
  });
});

describe("noclobber and {fd}> on /dev/null", () => {
  it.each([
    ["exec {fd}>", "exec {fd}> /dev/null"],
    ["exec {fd}>>", "exec {fd}>> /dev/null"],
  ])("%s opens it and sets the variable", async (_name, command) => {
    expect(
      await run(`set -C; ${command}; echo "rc=$? fd=\${fd-unset}"`),
    ).toEqual({ stdout: "rc=0 fd=10\n", stderr: "", exitCode: 0 });
  });

  it("an ordinary command with {fd}> /dev/null runs", async () => {
    expect(
      await run('set -C; echo hi {fd}> /dev/null; echo "rc=$? fd=${fd-unset}"'),
    ).toEqual({ stdout: "hi\nrc=0 fd=10\n", stderr: "", exitCode: 0 });
  });

  it("the descriptor can be written to and closed", async () => {
    expect(
      await run(
        'set -C; exec {fd}> /dev/null; echo hi >&$fd; echo "w=$?"; exec {fd}>&-; echo "c=$?"',
      ),
    ).toEqual({ stdout: "w=0\nc=0\n", stderr: "", exitCode: 0 });
  });
});
