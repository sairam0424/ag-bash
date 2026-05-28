/**
 * Meta-tests for the testing utilities.
 * Verifies that createTestBash, assertions, and fixtures work correctly.
 *
 * NOTE: bash.exec() calls below use the ag-bash virtual shell interpreter,
 * NOT child_process.exec(). All execution is sandboxed in-memory.
 */
import { describe, expect, it } from "vitest";
import {
  assertFails,
  assertFileExists,
  assertFileNotExists,
  assertOutput,
  assertStderr,
  assertSuccess,
  createTestBash,
  EMPTY_PROJECT,
  GIT_REPO,
  NODE_PROJECT,
} from "./index.js";

describe("Testing Utilities", () => {
  describe("createTestBash", () => {
    it("creates a working Bash instance with defaults", async () => {
      const bash = createTestBash();
      const result = await bash.exec("echo hello");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\n");
    });

    it("uses /home/user as default cwd", async () => {
      const bash = createTestBash();
      const result = await bash.exec("pwd");
      expect(result.stdout.trim()).toBe("/home/user");
    });

    it("accepts custom files", async () => {
      const bash = createTestBash({
        files: { "/data/test.txt": "file content\n" },
      });
      const result = await bash.exec("cat /data/test.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("file content\n");
    });

    it("accepts custom env", async () => {
      const bash = createTestBash({
        env: { MY_VAR: "custom_value" },
      });
      const result = await bash.exec("echo $MY_VAR");
      expect(result.stdout.trim()).toBe("custom_value");
    });

    it("accepts custom cwd", async () => {
      const bash = createTestBash({
        files: { "/project/file.txt": "data" },
        cwd: "/project",
      });
      const result = await bash.exec("pwd");
      expect(result.stdout.trim()).toBe("/project");
    });

    it("persists state between calls", async () => {
      const bash = createTestBash();
      await bash.exec("export MY_VAR=hello");
      const result = await bash.exec("echo $MY_VAR");
      expect(result.stdout.trim()).toBe("hello");
    });
  });

  describe("assertSuccess", () => {
    it("returns stdout on success", async () => {
      const bash = createTestBash();
      const result = await bash.exec("echo works");
      const stdout = assertSuccess(result);
      expect(stdout).toBe("works\n");
    });

    it("throws on non-zero exit code", async () => {
      const bash = createTestBash();
      const result = await bash.exec("false");
      expect(() => assertSuccess(result)).toThrow(
        "Expected exit code 0, got 1",
      );
    });
  });

  describe("assertFails", () => {
    it("passes on non-zero exit code", async () => {
      const bash = createTestBash();
      const result = await bash.exec("false");
      await expect(assertFails(result)).resolves.toBeUndefined();
    });

    it("throws on zero exit code", async () => {
      const bash = createTestBash();
      const result = await bash.exec("true");
      await expect(assertFails(result)).rejects.toThrow(
        "Expected failure but got success",
      );
    });

    it("checks specific exit code when provided", async () => {
      const bash = createTestBash();
      const result = await bash.exec("exit 2");
      await expect(assertFails(result, 2)).resolves.toBeUndefined();
      await expect(assertFails(result, 3)).rejects.toThrow(
        "Expected exit code 3 but got 2",
      );
    });

    it("checks stderr matches regex when provided", async () => {
      const bash = createTestBash();
      const result = await bash.exec("cat /no/such/file");
      await expect(assertFails(result, /No such file/)).resolves.toBeUndefined();
      await expect(assertFails(result, /wrong pattern/)).rejects.toThrow(
        "Expected stderr to match",
      );
    });

    it("accepts a Promise<ExecResult> directly", async () => {
      const bash = createTestBash();
      await expect(assertFails(bash.exec("false"))).resolves.toBeUndefined();
      await expect(assertFails(bash.exec("true"))).rejects.toThrow(
        "Expected failure but got success",
      );
    });
  });

  describe("assertOutput", () => {
    it("passes when stdout contains substring", async () => {
      const bash = createTestBash();
      const result = await bash.exec("echo hello world");
      expect(() => assertOutput(result, "hello")).not.toThrow();
    });

    it("throws when stdout does not contain substring", async () => {
      const bash = createTestBash();
      const result = await bash.exec("echo hello");
      expect(() => assertOutput(result, "goodbye")).toThrow(
        'Expected stdout to contain "goodbye"',
      );
    });
  });

  describe("assertStderr", () => {
    it("passes when stderr contains substring", async () => {
      const bash = createTestBash();
      const result = await bash.exec("echo error >&2");
      expect(() => assertStderr(result, "error")).not.toThrow();
    });

    it("throws when stderr does not contain substring", async () => {
      const bash = createTestBash();
      const result = await bash.exec("echo ok");
      expect(() => assertStderr(result, "missing")).toThrow(
        'Expected stderr to contain "missing"',
      );
    });
  });

  describe("assertFileExists", () => {
    it("passes when file exists", async () => {
      const bash = createTestBash({
        files: { "/test.txt": "content" },
      });
      await expect(
        assertFileExists(bash, "/test.txt"),
      ).resolves.toBeUndefined();
    });

    it("throws when file does not exist", async () => {
      const bash = createTestBash();
      await expect(assertFileExists(bash, "/missing.txt")).rejects.toThrow(
        "File /missing.txt does not exist",
      );
    });

    it("checks content when expectedContent is provided", async () => {
      const bash = createTestBash({
        files: { "/test.txt": "expected content" },
      });
      await expect(
        assertFileExists(bash, "/test.txt", "expected content"),
      ).resolves.toBeUndefined();
    });

    it("throws on content mismatch", async () => {
      const bash = createTestBash({
        files: { "/test.txt": "actual content" },
      });
      await expect(
        assertFileExists(bash, "/test.txt", "wrong content"),
      ).rejects.toThrow("content mismatch");
    });
  });

  describe("assertFileNotExists", () => {
    it("passes when file does not exist", async () => {
      const bash = createTestBash();
      await expect(
        assertFileNotExists(bash, "/nonexistent.txt"),
      ).resolves.toBeUndefined();
    });

    it("throws when file exists", async () => {
      const bash = createTestBash({
        files: { "/exists.txt": "data" },
      });
      await expect(assertFileNotExists(bash, "/exists.txt")).rejects.toThrow(
        "File /exists.txt exists but should not",
      );
    });
  });

  describe("Fixtures", () => {
    it("EMPTY_PROJECT can be used as files parameter", async () => {
      const bash = createTestBash({ files: EMPTY_PROJECT, cwd: "/project" });
      const result = await bash.exec("cat README.md");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("# Test Project\n");
    });

    it("NODE_PROJECT has package.json", async () => {
      const bash = createTestBash({ files: NODE_PROJECT, cwd: "/project" });
      const result = await bash.exec("cat package.json");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"name": "test"');
    });

    it("GIT_REPO has .git/HEAD", async () => {
      const bash = createTestBash({ files: GIT_REPO, cwd: "/repo" });
      const result = await bash.exec("cat .git/HEAD");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ref: refs/heads/main");
    });
  });
});
