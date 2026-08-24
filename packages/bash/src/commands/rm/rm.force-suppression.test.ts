/**
 * `rm -f` must suppress ONLY "target does not exist" (POSIX), never any other
 * failure.
 *
 * Regression: `rm -f` caught every error and, when `-f` was set, returned exit 0
 * with empty stderr. In plan mode the command layer correctly blocks the unlink
 * (the file survives) by throwing a `SecurityViolationError` — and `rm -f`
 * reported SUCCESS anyway. A denied destructive operation that reports exit 0
 * tells the caller, human or agent, that the removal happened.
 *
 * Real bash: `rm -f` on a nonexistent path is exit 0 and silent; `rm -f` on an
 * undeletable path still errors.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import type { IFileSystem } from "../../fs/interface.js";

/** Replace one fs method with a thrower, leaving the rest of the fs intact. */
function withInjectedFsError(
  fs: IFileSystem,
  method: "rm",
  error: Error,
): IFileSystem {
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === method) {
        return async () => {
          throw error;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as IFileSystem;
}

describe("rm -f error suppression", () => {
  it("reports a security denial instead of exit 0 in plan mode", async () => {
    const env = new Bash({
      files: { "/test.txt": "content" },
      agentic: { enabled: true },
    });
    env.setMode("plan");

    const result = await env.exec("rm -f /test.txt");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("rm: cannot remove '/test.txt'");
    expect(result.stderr).toContain("security violation");

    // The security control itself must still hold: the file survives.
    env.setMode("execute");
    const cat = await env.exec("cat /test.txt");
    expect(cat.exitCode).toBe(0);
    expect(cat.stdout).toBe("content");
  });

  it("still suppresses a genuinely missing target in plan mode", async () => {
    const env = new Bash({ agentic: { enabled: true } });
    env.setMode("plan");

    const result = await env.exec("rm -f /missing.txt");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("still suppresses a genuinely missing target in execute mode", async () => {
    const env = new Bash({ agentic: { enabled: true } });

    const result = await env.exec("rm -f /missing.txt");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("does not let -f suppress a permission error", async () => {
    const fs = withInjectedFsError(
      new InMemoryFs({ "/locked.txt": "content" }),
      "rm",
      new Error("EACCES: permission denied, unlink '/locked.txt'"),
    );
    const env = new Bash({ fs });

    const result = await env.exec("rm -f /locked.txt");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "rm: cannot remove '/locked.txt': EACCES: permission denied, unlink '/locked.txt'\n",
    );
  });

  it("does not let -f suppress a read-only filesystem error", async () => {
    const fs = withInjectedFsError(
      new InMemoryFs({ "/ro.txt": "content" }),
      "rm",
      new Error("EROFS: read-only file system, unlink '/ro.txt'"),
    );
    const env = new Bash({ fs });

    const result = await env.exec("rm -rf /ro.txt");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "rm: cannot remove '/ro.txt': EROFS: read-only file system, unlink '/ro.txt'\n",
    );
  });
});
