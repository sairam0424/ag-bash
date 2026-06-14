import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("env command", () => {
  it("should print all environment variables", async () => {
    const env = new Bash({
      env: { FOO: "bar", BAZ: "qux" },
    });
    const result = await env.exec("env");
    expect(result.stdout).toContain("FOO=bar");
    expect(result.stdout).toContain("BAZ=qux");
    expect(result.exitCode).toBe(0);
  });

  it("should include default environment variables", async () => {
    const env = new Bash();
    const result = await env.exec("env");
    expect(result.stdout).toContain("HOME=/");
    expect(result.stdout).toContain("PATH=/usr/bin:/bin");
  });

  it("should show help with --help", async () => {
    const env = new Bash();
    const result = await env.exec("env --help");
    expect(result.stdout).toContain("env");
    expect(result.stdout).toContain("environment");
    expect(result.exitCode).toBe(0);
  });

  it("should run command with empty environment when using -i", async () => {
    const env = new Bash({
      env: { FOO: "bar", PATH: "/usr/bin:/bin" },
    });
    const result = await env.exec("env -i printenv PATH");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("should apply NAME=VALUE with -i for command execution", async () => {
    const env = new Bash({
      env: { FOO: "bar" },
    });
    const result = await env.exec("env -i ONLY=value printenv ONLY");
    expect(result.stdout).toBe("value\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should unset variables for command execution with -u", async () => {
    const env = new Bash({
      env: { FOO: "bar", BAZ: "qux" },
    });
    const result = await env.exec("env -u FOO printenv FOO BAZ");
    expect(result.stdout).toBe("qux\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(1);
  });

  // Bash parity: a leading non-assignment argument names a COMMAND to run.
  // If that program does not exist, env exits 127 and prints an env-prefixed
  // "No such file or directory" diagnostic — it does NOT silently no-op (exit 0).
  // Oracle (host bash):
  //   env 'echo X ; #'  -> exit 127, "env: echo X ; #: No such file or directory"
  it("should exit 127 when the command name does not exist", async () => {
    const env = new Bash({ env: { FOO: "bar" } });
    const result = await env.exec("env 'echo X ; #'");
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("env: echo X ; #: No such file or directory\n");
  });

  it("must not execute the bogus name as a shell pipeline (no marker file)", async () => {
    // The bogus name contains shell metacharacters; env must treat the whole
    // thing as a single literal program name, never reparse it as shell source.
    const env = new Bash({ env: { FOO: "bar" } });
    const result = await env.exec("env 'echo X > /tmp/agmarker ; #'");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe(
      "env: echo X > /tmp/agmarker ; #: No such file or directory\n",
    );
    // The marker file must NOT have been created.
    const check = await env.exec("cat /tmp/agmarker");
    expect(check.exitCode).not.toBe(0);
  });

  it("should run a real command after a NAME=VALUE assignment", async () => {
    const env = new Bash({ env: { PATH: "/usr/bin:/bin", HOME: "/" } });
    const result = await env.exec("env FOO=bar echo hi");
    expect(result.stdout).toBe("hi\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should pass NAME=VALUE into the executed command's environment", async () => {
    const env = new Bash({ env: { PATH: "/usr/bin:/bin", HOME: "/" } });
    const result = await env.exec("env INJECTED=value printenv INJECTED");
    expect(result.stdout).toBe("value\n");
    expect(result.exitCode).toBe(0);
  });

  it("should exit 127 with env prefix when assignment precedes a bogus command", async () => {
    const env = new Bash({ env: { PATH: "/usr/bin:/bin", HOME: "/" } });
    const result = await env.exec("env FOO=bar nonexistprog");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe(
      "env: nonexistprog: No such file or directory\n",
    );
  });

  it("should pass through a real command's own non-zero exit without env prefix", async () => {
    // When the program runs and exits non-zero itself, env must NOT add an
    // "env:" diagnostic — it simply forwards the program's exit status.
    const env = new Bash({ env: { PATH: "/usr/bin:/bin", HOME: "/" } });
    const result = await env.exec("env false");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("env:");
  });
});

describe("printenv command", () => {
  it("should print all environment variables without args", async () => {
    const env = new Bash({
      env: { FOO: "bar" },
    });
    const result = await env.exec("printenv");
    expect(result.stdout).toContain("FOO=bar");
    expect(result.exitCode).toBe(0);
  });

  it("should print specific variable value", async () => {
    const env = new Bash({
      env: { FOO: "bar", BAZ: "qux" },
    });
    const result = await env.exec("printenv FOO");
    expect(result.stdout).toBe("bar\n");
    expect(result.exitCode).toBe(0);
  });

  it("should print multiple variable values", async () => {
    const env = new Bash({
      env: { FOO: "bar", BAZ: "qux" },
    });
    const result = await env.exec("printenv FOO BAZ");
    expect(result.stdout).toBe("bar\nqux\n");
  });

  it("should return exit code 1 for missing variable", async () => {
    const env = new Bash();
    const result = await env.exec("printenv NONEXISTENT");
    expect(result.exitCode).toBe(1);
  });

  it("should show help with --help", async () => {
    const env = new Bash();
    const result = await env.exec("printenv --help");
    expect(result.stdout).toContain("printenv");
    expect(result.exitCode).toBe(0);
  });
});

describe("env/printenv host isolation", () => {
  it("should not leak real host env vars via env", async () => {
    const bash = new Bash();
    const result = await bash.exec("env");
    // Should not contain common host env vars
    expect(result.stdout).not.toContain("NODE_ENV=");
    expect(result.stdout).not.toContain("SHELL=");
    expect(result.stdout).not.toContain("TERM=");
    expect(result.stdout).not.toContain("LANG=");
    expect(result.stdout).not.toContain("USER=");
  });

  it("should return virtual PATH, not host PATH", async () => {
    const bash = new Bash();
    const result = await bash.exec("printenv PATH");
    expect(result.stdout.trim()).toBe("/usr/bin:/bin");
    expect(result.stdout).not.toContain("/usr/local/bin");
  });
});
