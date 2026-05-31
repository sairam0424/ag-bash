import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

// Regression: every successful python3 run used to leak a bare
// `Traceback (most recent call last):` header to stderr. The header is emitted
// by CPython's Py_FinalizeEx when interpreter teardown re-touches the HOSTFS
// bridge (which then fails with EIO). The worker now marks the end of the user
// program with an unguessable stderr sentinel and suppresses everything written
// to fd 2 after it — while genuine tracebacks, printed before the sentinel, are
// preserved.

describe("python3 stderr finalization noise", () => {
  it("should NOT leak a spurious Traceback header on a successful run", {
    timeout: 60000,
  }, async () => {
    const env = new Bash({ runtimes: { python: true } });
    const result = await env.exec('python3 -c "print(1 + 2)"');
    expect(result.stdout).toBe("3\n");
    expect(result.exitCode).toBe(0);
    // The core of the bug: a clean run must produce empty stderr.
    expect(result.stderr).toBe("");
    expect(result.stderr).not.toContain("Traceback");
  });

  it("should keep stderr clean across exit codes (explicit sys.exit(0))", {
    timeout: 60000,
  }, async () => {
    const env = new Bash({ runtimes: { python: true } });
    const result = await env.exec(
      'python3 -c "print(1 + 2); import sys; sys.exit(0)"',
    );
    expect(result.stdout).toBe("3\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("should NOT leak finalization noise for a non-zero sys.exit", {
    timeout: 60000,
  }, async () => {
    const env = new Bash({ runtimes: { python: true } });
    const result = await env.exec(
      'python3 -c "print(1 + 2); import sys; sys.exit(5)"',
    );
    expect(result.stdout).toBe("3\n");
    expect(result.exitCode).toBe(5);
    expect(result.stderr).not.toContain("Traceback");
  });

  it("should preserve a genuine traceback for a real error", {
    timeout: 60000,
  }, async () => {
    const env = new Bash({ runtimes: { python: true } });
    const result = await env.exec('python3 -c "raise ValueError(\\"boom\\")"');
    expect(result.exitCode).not.toBe(0);
    // The real error and its type must still surface on stderr.
    expect(result.stderr).toContain("Traceback (most recent call last):");
    expect(result.stderr).toContain("ValueError");
    expect(result.stderr).toContain("boom");
  });

  it("should preserve genuine user writes to sys.stderr", {
    timeout: 60000,
  }, async () => {
    const env = new Bash({ runtimes: { python: true } });
    const result = await env.exec(
      'python3 -c "import sys; sys.stderr.write(\\"my-own-warning\\n\\"); print(99)"',
    );
    expect(result.stdout).toBe("99\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("my-own-warning");
    expect(result.stderr).not.toContain("Traceback");
  });
});
