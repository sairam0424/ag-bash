/**
 * `/dev/null`, `/dev/stdout`, `/dev/stderr` and `/dev/full` are handled by the
 * redirection code itself; they are never opened as files. The up-front checks
 * that report an unusable redirect target (missing parent directory, directory
 * target, noclobber) must therefore leave them alone.
 *
 * A host-backed `ReadWriteFs` whose root has no `/dev` directory made this
 * visible: `(echo hi) 2>/dev/null` and its siblings reported
 * `No such file or directory` (and did not run the body) once the pre-open
 * step started stat()ing the parent directory of every target.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { ReadWriteFs } from "../fs/read-write-fs/read-write-fs.js";

interface DeviceScript {
  readonly name: string;
  readonly script: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Scripts that redirect to a virtual device. The expectations are what the
 * default in-memory filesystem (which does have `/dev`) produces, and what bash
 * produces, so they hold on both filesystems.
 */
const DEVICE_SCRIPTS: readonly DeviceScript[] = [
  {
    name: "subshell to /dev/null",
    script: "(echo hi) 2>/dev/null",
    stdout: "hi\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "for loop to /dev/null",
    script: "for i in 1 2; do echo $i; done 2>/dev/null",
    stdout: "1\n2\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "case to /dev/null",
    script: "case a in a) echo y;; esac 2>/dev/null",
    stdout: "y\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "[[ ]] to /dev/null",
    script: "[[ -n x ]] 2>/dev/null",
    stdout: "",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "(( )) to /dev/null",
    script: "(( 1 )) 2>/dev/null",
    stdout: "",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "assignment only to /dev/null",
    script: 'x=1 2>/dev/null; echo "x=$x"',
    stdout: "x=1\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "bare redirect to /dev/null",
    script: "2>/dev/null",
    stdout: "",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "subshell to /dev/stdout",
    script: "(echo hi) > /dev/stdout",
    stdout: "hi\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "subshell stdout to /dev/stderr",
    script: "(echo hi) > /dev/stderr",
    stdout: "",
    stderr: "hi\n",
    exitCode: 0,
  },
  {
    name: "subshell stderr to /dev/stderr",
    script: "(echo hi >&2) 2> /dev/stderr",
    stdout: "",
    stderr: "hi\n",
    exitCode: 0,
  },
  {
    name: "subshell to /dev/full",
    script: "(echo hi) > /dev/full",
    stdout: "",
    stderr: "bash: /dev/full: No space left on device\n",
    exitCode: 1,
  },
  {
    name: "descriptor variable on /dev/null",
    script: 'exec {fd}>/dev/null; echo "fd=$fd"',
    stdout: "fd=10\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "descriptor variable on an ordinary command",
    script: "echo hi {fd}>/dev/null",
    stdout: "hi\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "descriptor variable on /dev/full",
    script: 'exec {fd}>/dev/full; echo "fd=$fd"',
    stdout: "fd=10\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "descriptor variable on /dev/stdout",
    script: 'exec {fd}>/dev/stdout; echo "fd=$fd"',
    stdout: "fd=10\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "descriptor variable on /dev/stderr",
    script: 'exec {fd}>/dev/stderr; echo "fd=$fd"',
    stdout: "fd=10\n",
    stderr: "",
    exitCode: 0,
  },
];

describe("redirects to virtual devices", () => {
  describe("on the default in-memory filesystem", () => {
    it.each(DEVICE_SCRIPTS)("$name", async (c) => {
      const env = new Bash();
      try {
        const result = await env.exec(c.script);
        expect({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }).toEqual({
          stdout: c.stdout,
          stderr: c.stderr,
          exitCode: c.exitCode,
        });
      } finally {
        env.destroy();
      }
    });
  });

  describe("on a ReadWriteFs whose root has no /dev directory", () => {
    let rootDir: string;

    beforeEach(() => {
      rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "redirect-devices-"));
    });

    afterEach(() => {
      fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it.each(DEVICE_SCRIPTS)("$name", async (c) => {
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
        }).toEqual({
          stdout: c.stdout,
          stderr: c.stderr,
          exitCode: c.exitCode,
        });
      } finally {
        env.destroy();
      }
    });

    it("does not create a /dev directory on the host", async () => {
      const env = new Bash({
        fs: new ReadWriteFs({ root: rootDir }),
        cwd: "/",
      });
      try {
        await env.exec("(echo hi) 2>/dev/null; exec {fd}>/dev/null");
        expect(fs.existsSync(path.join(rootDir, "dev"))).toBe(false);
      } finally {
        env.destroy();
      }
    });
  });
});

describe("noclobber does not refuse device files", () => {
  // Under `set -C` bash only refuses to overwrite a regular file. The default
  // filesystem models /dev/null, /dev/zero, /dev/stdout and /dev/stderr as
  // ordinary (empty) files, so a list of device names is exempt instead.
  // Allowing /dev/stdout and /dev/stderr (rc 0) mirrors Linux bash 5.2 when
  // fd 1/2 is a pipe or a tty; macOS bash 5.3 refuses even for a pipe, and
  // both refuse when fd 1/2 is a regular file.
  it.each([
    "/dev/null",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/zero",
  ])("exec {fd}> %s", async (device) => {
    const env = new Bash();
    try {
      const result = await env.exec(
        `set -C; exec {fd}> ${device}; echo "rc=$? fd=\${fd-unset}"`,
      );
      expect(result.stdout).toBe("rc=0 fd=10\n");
      expect(result.stderr).toBe("");
    } finally {
      env.destroy();
    }
  });

  it.each([
    ["simple command", ": > /dev/zero"],
    ["assignment only", "x=1 > /dev/zero"],
    ["subshell", "( : ) > /dev/zero"],
    ["for loop", "for i in 1; do :; done > /dev/zero"],
    ["&>", ": &> /dev/zero"],
    [">&", ": >& /dev/zero"],
    ["a relative path into /dev", "cd /dev; : > zero"],
    ["a path that reaches /dev through ..", ": > /tmp/../dev/zero"],
  ])("%s", async (_name, script) => {
    const env = new Bash();
    try {
      const result = await env.exec(`set -C; ${script}; echo "rc=$?"`);
      expect(result.stdout).toBe("rc=0\n");
      expect(result.stderr).toBe("");
    } finally {
      env.destroy();
    }
  });

  it.each([
    ["exec {fd}>", "exec {fd}> %s"],
    ["a subshell", "( : ) > %s"],
    ["a simple command", ": > %s"],
  ])("still refuses an ordinary file, through %s", async (_name, template) => {
    const env = new Bash();
    try {
      // `dev/f` and `devfile` only look like device paths.
      const result = await env.exec(
        "mkdir dev; echo old > dev/f; echo old > devfile; set -C; " +
          `${template.replace("%s", "dev/f")}; echo "rc=$?"; ` +
          `${template.replace("%s", "devfile")}; echo "rc=$?"; ` +
          'echo "[$(cat dev/f)] [$(cat devfile)]"',
      );
      expect(result.stdout).toBe("rc=1\nrc=1\n[old] [old]\n");
      expect(result.stderr).toContain("cannot overwrite existing file");
    } finally {
      env.destroy();
    }
  });
});

describe("noclobber still protects regular files near /dev", () => {
  // Only the device names are exempt: a regular file under /dev, or one whose
  // name merely starts with "dev" at the root, keeps its protection.
  const FORMS: ReadonlyArray<readonly [string, string]> = [
    ["exec {fd}>", "exec {fd}> %s"],
    ["a subshell", "( : ) > %s"],
    ["a simple command", ": > %s"],
    ["&>", ": &> %s"],
  ];

  it.each(
    FORMS,
  )("a regular file under /dev, through %s", async (_name, template) => {
    const env = new Bash();
    try {
      const result = await env.exec(
        "mkdir -p /dev/shm; echo a > /dev/shm/x; set -C; " +
          `${template.replace("%s", "/dev/shm/x")}; ` +
          'echo "rc=$? [$(cat /dev/shm/x)]"',
      );
      expect(result.stdout).toBe("rc=1 [a]\n");
      expect(result.stderr).toContain("cannot overwrite existing file");
    } finally {
      env.destroy();
    }
  });

  it.each(
    FORMS,
  )("/devfile at the root, through %s", async (_name, template) => {
    const env = new Bash();
    try {
      const result = await env.exec(
        "cd /; echo old > devfile; set -C; " +
          `${template.replace("%s", "devfile")}; ` +
          'echo "rc=$? [$(cat devfile)]"',
      );
      expect(result.stdout).toBe("rc=1 [old]\n");
      expect(result.stderr).toContain("cannot overwrite existing file");
    } finally {
      env.destroy();
    }
  });

  it("an echo into /devfile does not overwrite it", async () => {
    const env = new Bash();
    try {
      const result = await env.exec(
        'cd /; echo old > devfile; set -C; echo x > devfile; echo "rc=$? [$(cat devfile)]"',
      );
      expect(result.stdout).toBe("rc=1 [old]\n");
    } finally {
      env.destroy();
    }
  });
});
