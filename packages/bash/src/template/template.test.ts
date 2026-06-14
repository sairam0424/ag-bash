import { describe, expect, it } from "vitest";
import { createShell, shellEscape } from "./index.js";

describe("shellEscape", () => {
  it("passes safe strings unquoted", () => {
    expect(shellEscape("hello")).toBe("hello");
    expect(shellEscape("path/to/file.ts")).toBe("path/to/file.ts");
  });

  it("quotes strings with spaces", () => {
    expect(shellEscape("hello world")).toBe("'hello world'");
  });

  it("escapes single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it("handles numbers", () => {
    expect(shellEscape(42)).toBe("42");
  });

  it("handles booleans", () => {
    expect(shellEscape(true)).toBe("true");
    expect(shellEscape(false)).toBe("false");
  });

  it("handles null/undefined", () => {
    expect(shellEscape(null)).toBe("''");
    expect(shellEscape(undefined)).toBe("''");
  });

  it("handles arrays", () => {
    expect(shellEscape(["a", "b c"])).toBe("a 'b c'");
  });

  it("handles special characters", () => {
    expect(shellEscape("$HOME")).toBe("'$HOME'");
    expect(shellEscape("; rm -rf /")).toBe("'; rm -rf /'");
  });

  it("handles strings with backticks", () => {
    expect(shellEscape("`whoami`")).toBe("'`whoami`'");
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });
});

describe("createShell", () => {
  it("executes simple commands", async () => {
    const $ = createShell();
    const result = await $`echo hello`;
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("interpolates values safely", async () => {
    const $ = createShell();
    const name = "world";
    const result = await $`echo ${name}`;
    expect(result.stdout.trim()).toBe("world");
  });

  it("prevents injection via interpolation", async () => {
    const $ = createShell();
    const evil = "; echo hacked";
    const result = await $`echo ${evil}`;
    // Should print the literal string, not execute it as a separate command.
    // If injection worked, stdout would be two lines: "" and "hacked"
    expect(result.stdout.trim()).toBe("; echo hacked");
    // Verify it's a single echo output, not two commands
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("prevents variable expansion in interpolated values", async () => {
    const $ = createShell();
    await $`export SECRET=password123`;
    const malicious = "$SECRET";
    const result = await $`echo ${malicious}`;
    expect(result.stdout.trim()).toBe("$SECRET");
  });

  it("prevents command substitution in interpolated values", async () => {
    const $ = createShell();
    const malicious = "$(echo pwned)";
    const result = await $`echo ${malicious}`;
    expect(result.stdout.trim()).toBe("$(echo pwned)");
  });

  it("persists state between calls", async () => {
    const $ = createShell();
    await $`export FOO=bar`;
    const result = await $`echo $FOO`;
    expect(result.stdout.trim()).toBe("bar");
  });

  it("cd changes directory", async () => {
    const $ = createShell({ files: { "/tmp/test.txt": "content" } });
    await $.cd("/tmp");
    const result = await $`pwd`;
    expect(result.stdout.trim()).toBe("/tmp");
  });

  it("cd throws on invalid directory", async () => {
    const $ = createShell();
    await expect($.cd("/nonexistent/path")).rejects.toThrow("cd:");
  });

  it("exposes underlying bash instance", () => {
    const $ = createShell();
    expect($.bash).toBeDefined();
    expect($.bash).toBeInstanceOf(Object);
  });

  it("handles array interpolation", async () => {
    const $ = createShell();
    const args = ["one", "two three"];
    const result = await $`echo ${args}`;
    expect(result.stdout.trim()).toBe("one two three");
  });

  it("handles number interpolation", async () => {
    const $ = createShell();
    const count = 42;
    const result = await $`echo ${count}`;
    expect(result.stdout.trim()).toBe("42");
  });

  it("handles multiple interpolations", async () => {
    const $ = createShell();
    const greeting = "hello";
    const target = "world";
    const result = await $`echo ${greeting} ${target}`;
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("passes custom options to Bash", async () => {
    const $ = createShell({
      cwd: "/home/user",
      files: { "/home/user/data.txt": "test content" },
    });
    const result = await $`cat data.txt`;
    expect(result.stdout).toBe("test content");
  });
});
