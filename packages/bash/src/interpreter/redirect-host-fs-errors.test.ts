/**
 * Output redirections whose write fails after the up-front checks passed.
 *
 * The in-memory filesystem only ever fails a redirect because the target is a
 * directory or its parent is missing, which checkOutputRedirectTarget() sees
 * beforehand. A host-backed filesystem (ReadWriteFs mounted into the sandbox)
 * can also refuse the write itself: permission denied on a read-only directory,
 * or a symlink it is configured not to follow. Those errors used to escape
 * exec() as `EACCES: ...` rejections from every redirect form, not just from
 * assignment-only commands.
 *
 * bash reports them as "Permission denied", exit status 1, and carries on.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/in-memory-fs.js";
import { MountableFs } from "../fs/mountable-fs/mountable-fs.js";
import { OverlayFs } from "../fs/overlay-fs/overlay-fs.js";
import { ReadWriteFs } from "../fs/read-write-fs/read-write-fs.js";

const MOUNT = "/work";

/** Command contexts; `T` is replaced with the unusable target path. */
const CONTEXTS: ReadonlyArray<readonly [string, string]> = [
  ["assignment only", 'x=1 > T; echo "rc=$? x=$x"'],
  ["bare redirect", '> T; echo "rc=$?"'],
  ["echo", 'echo hi > T; echo "rc=$?"'],
  ["append", 'echo hi >> T; echo "rc=$?"'],
  ["stderr", 'echo hi 2> T; echo "rc=$?"'],
  ["stdout and stderr", 'echo hi &> T; echo "rc=$?"'],
  ["subshell", '( echo hi ) > T; echo "rc=$?"'],
  ["group", '{ echo hi; } > T; echo "rc=$?"'],
  ["descriptor variable", 'echo hi {fd}> T; echo "rc=$?"'],
  [
    "write through a numbered descriptor",
    'exec 3> T; echo hi >&3; echo "rc=$?"',
  ],
];

describe("redirect writes refused by a host-backed filesystem", () => {
  let tempDir: string;

  function makeBash(): Bash {
    const mountable = new MountableFs({ base: new InMemoryFs() });
    mountable.mount(MOUNT, new ReadWriteFs({ root: tempDir }));
    return new Bash({ fs: mountable, cwd: MOUNT });
  }

  // chmod is not enforced for root, and does not apply on Windows.
  const canRestrictDirectories =
    process.platform !== "win32" && process.getuid?.() !== 0;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redirect-host-fs-"));
    fs.mkdirSync(path.join(tempDir, "adir"));
    fs.writeFileSync(path.join(tempDir, "afile"), "data");
    if (process.platform !== "win32") {
      fs.symlinkSync("afile", path.join(tempDir, "link"));
    }
    const readOnly = path.join(tempDir, "ro");
    fs.mkdirSync(readOnly);
    if (canRestrictDirectories) {
      fs.chmodSync(readOnly, 0o555);
    }
  });

  afterEach(() => {
    // Restore write permission so the temporary tree can be removed.
    fs.chmodSync(path.join(tempDir, "ro"), 0o755);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe.skipIf(!canRestrictDirectories)(
    "permission denied on a read-only directory",
    () => {
      it.each(CONTEXTS)("%s", async (_name, template) => {
        const env = makeBash();
        try {
          const result = await env.exec(template.replace(/T/g, "ro/f"));
          expect(result.stderr).toContain("Permission denied");
          expect(result.stdout).toContain("rc=1");
          expect(fs.existsSync(path.join(tempDir, "ro", "f"))).toBe(false);
        } finally {
          env.destroy();
        }
      });
    },
  );

  describe.skipIf(process.platform === "win32")(
    "a symlink the filesystem refuses to follow",
    () => {
      it.each(CONTEXTS)("%s", async (_name, template) => {
        const env = makeBash();
        try {
          const result = await env.exec(template.replace(/T/g, "link"));
          expect(result.stderr).toContain("Permission denied");
          expect(result.stdout).toContain("rc=1");
        } finally {
          env.destroy();
        }
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails assignment-only commands but keeps the assignment",
    async () => {
      const env = makeBash();
      try {
        const result = await env.exec('x=1 > link; echo "rc=$? x=$x"');
        expect(result.stdout).toBe("rc=1 x=1\n");
        expect(result.stderr).toBe("bash: link: Permission denied\n");
      } finally {
        env.destroy();
      }
    },
  );

  it("does not create the missing parent directory on the host", async () => {
    const env = makeBash();
    try {
      const result = await env.exec('x=1 > nodir/f; echo "rc=$?"');
      expect(result.stdout).toBe("rc=1\n");
      expect(result.stderr).toBe("bash: nodir/f: No such file or directory\n");
      expect(fs.existsSync(path.join(tempDir, "nodir"))).toBe(false);
    } finally {
      env.destroy();
    }
  });

  it("reports a directory target for a descriptor variable", async () => {
    const env = makeBash();
    try {
      const result = await env.exec('echo hi {fd}> adir; echo "rc=$?"');
      expect(result.stdout).toBe("rc=1\n");
      expect(result.stderr).toBe("bash: adir: Is a directory\n");
    } finally {
      env.destroy();
    }
  });
});

describe("a descriptor whose directory disappears after it was opened", () => {
  it("fails the write instead of rejecting", async () => {
    // In bash the write still succeeds (the descriptor outlives the unlinked
    // file); the in-memory filesystem has no such thing, so the write is
    // reported as failed - but exec() must not reject.
    const env = new Bash();
    const result = await env.exec(
      'mkdir d; exec 3> d/f; rm -r d; echo hi >&3; echo "rc=$?"',
    );
    expect(result.stdout).toBe("rc=1\n");
    expect(result.stderr).toContain("No such file or directory");
  });
});

/** An in-memory filesystem whose writes to `/boom` fail with a chosen error. */
class FailingWriteFs extends InMemoryFs {
  constructor(private readonly failure: Error) {
    super();
  }

  override async writeFile(
    ...args: Parameters<InMemoryFs["writeFile"]>
  ): Promise<void> {
    if (args[0].endsWith("/boom")) {
      throw this.failure;
    }
    return super.writeFile(...args);
  }
}

describe("errors raised by a filesystem while a redirect is written", () => {
  it.each([
    [
      "ENOSPC: no space left on device, write '/boom'",
      "No space left on device",
    ],
    ["EPERM: operation not permitted, open '/boom'", "Operation not permitted"],
    ["EACCES: permission denied, open '/boom'", "Permission denied"],
    ["EIO: i/o error, write", "Input/output error"],
  ])("%s is reported as a command failure", async (failure, message) => {
    const env = new Bash({ fs: new FailingWriteFs(new Error(failure)) });
    try {
      const result = await env.exec('x=1 > boom; echo "rc=$? x=$x"');
      expect(result.stdout).toBe("rc=1 x=1\n");
      expect(result.stderr).toBe(`bash: boom: ${message}\n`);

      const later = await env.exec('echo hi > boom; echo "rc=$?"');
      expect(later.stdout).toBe("rc=1\n");
      expect(later.stderr).toBe(`bash: boom: ${message}\n`);
    } finally {
      env.destroy();
    }
  });

  it("does not swallow an error that is not a filesystem error", async () => {
    const env = new Bash({ fs: new FailingWriteFs(new Error("kaboom")) });
    try {
      await expect(env.exec("x=1 > boom")).rejects.toThrow("kaboom");
      await expect(env.exec("echo hi > boom")).rejects.toThrow("kaboom");
    } finally {
      env.destroy();
    }
  });
});

describe("what the command already produced when its redirect fails", () => {
  const failure = new Error("ENOSPC: no space left on device, write '/boom'");

  it("keeps the stderr of a group that ran before the write failed", async () => {
    const env = new Bash({ fs: new FailingWriteFs(failure) });
    try {
      const result = await env.exec(
        '{ echo before >&2; echo out; } > boom; echo "rc=$?"',
      );
      expect(result.stdout).toBe("rc=1\n");
      expect(result.stderr).toBe(
        "before\nbash: boom: No space left on device\n",
      );
    } finally {
      env.destroy();
    }
  });

  it("keeps the stderr of a simple command that ran before the write failed", async () => {
    const env = new Bash({ fs: new FailingWriteFs(failure) });
    try {
      const result = await env.exec('cat missing > boom; echo "rc=$?"');
      expect(result.stdout).toBe("rc=1\n");
      expect(result.stderr).toBe(
        "cat: missing: No such file or directory\nbash: boom: No space left on device\n",
      );
    } finally {
      env.destroy();
    }
  });

  it("drops the stdout that was meant for the file", async () => {
    const env = new Bash({ fs: new FailingWriteFs(failure) });
    try {
      const result = await env.exec("echo out > boom");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
    } finally {
      env.destroy();
    }
  });
});

describe("a read-only filesystem", () => {
  // EROFS is deliberately NOT turned into a failed command: the CLI's
  // read-only mode reports a refused write as the raised EROFS error
  // (src/cli/ag-bash.test.ts "should block writes by default" pins it). This
  // pins the same behaviour at the interpreter level for every redirect form.
  // Changing it is the owner's call and needs both tests updated together.
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "redirect-erofs-"));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it.each([
    ["simple command", "echo hi > newfile"],
    ["assignment only", "x=1 > newfile"],
    ["bare redirect", "> newfile"],
    ["subshell", "( echo hi ) > newfile"],
    ["for loop", "for i in 1 2; do echo $i; done > newfile"],
    ["append", "echo hi >> newfile"],
    ["stderr", "echo hi 2> newfile"],
    ["descriptor variable", "exec {fd}> newfile"],
    ["exit", "exit 3 > newfile"],
  ])("%s still raises EROFS", async (_name, script) => {
    const overlay = new OverlayFs({ root: rootDir, readOnly: true });
    const env = new Bash({ fs: overlay, cwd: overlay.getMountPoint() });
    try {
      await expect(env.exec(script)).rejects.toThrow(/EROFS/);
    } finally {
      env.destroy();
    }
  });
});

describe("filesystem errors identified by their code property", () => {
  /** An error whose message has no `EXXX:` prefix, only a `code`. */
  const withCode = (code: string): Error =>
    Object.assign(new Error("denied by policy"), { code });

  it.each([
    ["EACCES", "Permission denied"],
    ["ENOSPC", "No space left on device"],
    ["EIO", "Input/output error"],
  ])("code %s is reported as a command failure", async (code, message) => {
    const env = new Bash({ fs: new FailingWriteFs(withCode(code)) });
    try {
      const result = await env.exec('x=1 > boom; echo "rc=$? x=$x"');
      expect(result.stdout).toBe("rc=1 x=1\n");
      expect(result.stderr).toBe(`bash: boom: ${message}\n`);

      const later = await env.exec('echo hi > boom; echo "rc=$?"');
      expect(later.stdout).toBe("rc=1\n");
      expect(later.stderr).toBe(`bash: boom: ${message}\n`);
    } finally {
      env.destroy();
    }
  });

  it.each([
    "EROFS",
    "ENOTEMPTY",
    "EXDEV",
    "ERR_SOMETHING",
  ])("code %s is not converted and still rejects", async (code) => {
    const env = new Bash({ fs: new FailingWriteFs(withCode(code)) });
    try {
      await expect(env.exec("x=1 > boom")).rejects.toThrow("denied by policy");
      await expect(env.exec("echo hi > boom")).rejects.toThrow(
        "denied by policy",
      );
    } finally {
      env.destroy();
    }
  });

  it.each([
    "ENOTEMPTY: directory not empty, write '/boom'",
    "EXDEV: cross-device link not permitted, write '/boom'",
    "EROFS: read-only file system, write '/boom'",
  ])("%s (message prefix only) still rejects", async (message) => {
    const env = new Bash({ fs: new FailingWriteFs(new Error(message)) });
    try {
      await expect(env.exec("x=1 > boom")).rejects.toThrow(message);
      await expect(env.exec("echo hi > boom")).rejects.toThrow(message);
    } finally {
      env.destroy();
    }
  });
});

/** Every errno code a failed redirect write is reported for, with bash's text. */
const ERRNO_TEXTS: ReadonlyArray<readonly [string, string]> = [
  ["ENOENT", "No such file or directory"],
  ["ENOTDIR", "Not a directory"],
  ["EISDIR", "Is a directory"],
  ["EACCES", "Permission denied"],
  ["EPERM", "Operation not permitted"],
  ["ENOSPC", "No space left on device"],
  ["EFBIG", "File too large"],
  ["ELOOP", "Too many levels of symbolic links"],
  ["ENAMETOOLONG", "File name too long"],
  ["EEXIST", "File exists"],
  ["EBUSY", "Device or resource busy"],
  ["EMFILE", "Too many open files"],
  ["EIO", "Input/output error"],
];

describe("the text reported for each errno code", () => {
  describe.each([
    [
      "from the message prefix",
      (code: string) => new Error(`${code}: injected failure, write '/boom'`),
    ],
    [
      "from the code property",
      (code: string) => Object.assign(new Error("denied by policy"), { code }),
    ],
  ])("%s", (_how, makeError) => {
    it.each(ERRNO_TEXTS)("%s is %s", async (code, text) => {
      const env = new Bash({ fs: new FailingWriteFs(makeError(code)) });
      try {
        const assignment = await env.exec('x=1 > boom; echo "rc=$?"');
        expect(assignment.stdout).toBe("rc=1\n");
        expect(assignment.stderr).toBe(`bash: boom: ${text}\n`);

        const command = await env.exec('echo hi > boom; echo "rc=$?"');
        expect(command.stdout).toBe("rc=1\n");
        expect(command.stderr).toBe(`bash: boom: ${text}\n`);
      } finally {
        env.destroy();
      }
    });
  });
});
