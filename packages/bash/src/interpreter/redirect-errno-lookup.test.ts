/**
 * Only the errno codes that redirectFailureMessage() lists are turned into a
 * failed command. Any other value that reaches the code-to-text lookup (names
 * inherited from Object.prototype, an empty or lower-case string, a code that
 * is not a string, an errno bash would also report but this table leaves out)
 * must come out the other end exactly as it went in: the original error,
 * rejecting exec().
 *
 * A lookup written as a plain object literal would answer `constructor`,
 * `toString`, `hasOwnProperty` and `__proto__` with an inherited function or
 * object and print `bash: boom: function Object() { [native code] }` instead of
 * rejecting; these tests pin that this does not happen. The expectations are
 * the behaviour before the lookup was a table, so they hold for a switch and
 * for a table alike.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/in-memory-fs.js";

/** An in-memory filesystem whose writes to `/boom` fail with a chosen value. */
class FailingWriteFs extends InMemoryFs {
  constructor(private readonly failure: unknown) {
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

/** Both redirect shapes that report a failed write: no command word, and echo. */
const SCRIPTS: readonly string[] = ["x=1 > boom", "echo hi > boom"];

/** An error whose message has no `EXXX:` prefix, only a `code`. */
const withCode = (code: unknown): Error =>
  Object.assign(new Error("denied by policy"), { code });

async function expectRejectsWith(
  failure: unknown,
  expected: unknown,
): Promise<void> {
  for (const script of SCRIPTS) {
    const env = new Bash({ fs: new FailingWriteFs(failure) });
    try {
      await expect(env.exec(script)).rejects.toBe(expected);
    } finally {
      env.destroy();
    }
  }
}

describe("a listed code is still converted (control)", () => {
  it.each([
    ["ENOENT", "No such file or directory"],
    ["EIO", "Input/output error"],
  ])("code %s", async (code, text) => {
    const env = new Bash({ fs: new FailingWriteFs(withCode(code)) });
    try {
      const result = await env.exec('echo hi > boom; echo "rc=$?"');
      expect(result.stdout).toBe("rc=1\n");
      expect(result.stderr).toBe(`bash: boom: ${text}\n`);
    } finally {
      env.destroy();
    }
  });
});

describe("an unlisted code property is not converted", () => {
  it.each([
    // Names every plain object inherits.
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__proto__",
    "__defineGetter__",
    // Strings that are close to a listed code but are not one.
    "",
    " ",
    "enoent",
    "Enoent",
    "ENOENT ",
    " ENOENT",
    "ENOENT:",
    "ENOENTX",
    // Real errno codes the table leaves out.
    "ENOTEMPTY",
    "EROFS",
    "EXDEV",
    "EAGAIN",
    "ETIMEDOUT",
  ])("code %j still rejects with the original error", async (code) => {
    const failure = withCode(code);
    await expectRejectsWith(failure, failure);
  });

  it.each([
    ["a number", 2],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
    ["an array holding a listed code", ["ENOENT"]],
    ["a String object holding a listed code", Object("ENOENT")],
    ["a function", () => "ENOENT"],
    ["a symbol", Symbol("ENOENT")],
    ["true", true],
  ])("a non-string code (%s) still rejects with the original error", async (_name, code) => {
    const failure = withCode(code);
    await expectRejectsWith(failure, failure);
  });
});

describe("an unlisted message prefix is not converted", () => {
  it.each([
    "constructor: injected failure, write '/boom'",
    "toString: injected failure, write '/boom'",
    "hasOwnProperty: injected failure, write '/boom'",
    "__proto__: injected failure, write '/boom'",
    ": injected failure, write '/boom'",
    "enoent: injected failure, write '/boom'",
    "E: injected failure, write '/boom'",
    "ENOENT injected failure, write '/boom'",
    " ENOENT: injected failure, write '/boom'",
    "ENOTEMPTY: directory not empty, write '/boom'",
    "EROFS: read-only file system, write '/boom'",
  ])("%s still rejects with the original error", async (message) => {
    const failure = new Error(message);
    await expectRejectsWith(failure, failure);
  });
});

describe("a thrown value that is not an Error is not converted", () => {
  // The code is only read from instances of Error.
  it.each([
    ["a string", "ENOENT: no such file or directory, open '/boom'"],
    ["a plain object with a code", { code: "ENOENT" }],
    ["a plain object with a message", { message: "ENOENT: x" }],
  ])("%s still rejects with the original value", async (_name, failure) => {
    await expectRejectsWith(failure, failure);
  });
});
