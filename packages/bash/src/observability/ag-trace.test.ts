import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("AgTrace observability", () => {
  it("should provide suggestions for command typos", async () => {
    const bash = new Bash({ agentic: true });
    const result = await bash.exec("cho hello");
    expect(result.exitCode).toBe(127);
    expect(result.observations).toBeDefined();
    const obs = result.observations!.find(
      (o) => o.type === "command_not_found",
    );
    expect(obs).toBeDefined();
    expect(obs!.suggestions).toContain("echo");
  });

  it("should detect case-insensitive file matches", async () => {
    const bash = new Bash({
      agentic: true,
      files: {
        "README.md": "content",
      },
    });
    // In our shell, 'cat' for a non-existent file returns 1
    const result = await bash.exec("cat readme.md");
    expect(result.exitCode).not.toBe(0);
    expect(result.observations).toBeDefined();
    const obs = result.observations!.find((o) => o.type === "file_not_found");
    expect(obs).toBeDefined();
    expect(obs!.suggestions).toContain("Correct the casing to 'README.md'");
  });

  it("should identify missing parent directories", async () => {
    const bash = new Bash({ agentic: true });
    const result = await bash.exec("cat /tmp/nonexistent/file.txt");
    expect(result.observations).toBeDefined();
    const obs = result.observations!.find(
      (o) => o.type === "directory_not_found",
    );
    expect(obs).toBeDefined();
    // Path resolution might vary, but it should find the first missing component
    expect(obs!.message).toContain("does not exist");
  });

  it("should analyze syntax errors", async () => {
    const bash = new Bash({ agentic: true });
    const result = await bash.exec("if true; then echo"); // missing 'fi'
    expect(result.exitCode).toBe(2);
    expect(result.observations).toBeDefined();
    const obs = result.observations!.find((o) => o.type === "syntax_error");
    expect(obs).toBeDefined();
  });

  it("should handle execution limits", async () => {
    const bash = new Bash({
      agentic: true,
      executionLimits: { maxCommandCount: 2 },
    });
    const result = await bash.exec("echo 1; echo 2; echo 3");
    expect(result.exitCode).toBe(126);
    expect(result.observations).toBeDefined();
    const obs = result.observations!.find((o) => o.type === "limit_exceeded");
    expect(obs).toBeDefined();
    expect(obs!.context?.limitType).toBe("commands");
  });
});
