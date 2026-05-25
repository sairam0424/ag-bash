import { describe, it, expect } from "vitest";
import { Bash } from "../../Bash.js";

describe("commands", () => {
  const bash = new Bash({ persistState: true });

  it("lists all commands grouped by category", async () => {
    const result = await bash.exec("commands");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Core I/O:");
    expect(result.stdout).toContain("Text Processing:");
    expect(result.stdout).toContain("Agentic Tools:");
    expect(result.stdout).toContain("total):");
  });

  it("--list outputs flat names", async () => {
    const result = await bash.exec("commands --list");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("echo\n");
    expect(result.stdout).toContain("grep\n");
    expect(result.stdout).not.toContain(":");
  });

  it("--search finds matching commands", async () => {
    const result = await bash.exec("commands --search json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("jq");
  });

  it("--search shows no results message", async () => {
    const result = await bash.exec("commands --search xyznonexistent");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commands matching");
  });

  it("--category filters by category", async () => {
    const result = await bash.exec("commands --category data");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("jq");
    expect(result.stdout).toContain("Data & Structured");
  });

  it("--category with unknown category shows error", async () => {
    const result = await bash.exec("commands --category nonexistent");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown category");
  });

  it("commands echo shows help for echo", async () => {
    const result = await bash.exec("commands echo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("--help shows usage", async () => {
    const result = await bash.exec("commands --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("list all available");
  });
});
