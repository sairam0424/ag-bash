import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("about", () => {
  const bash = new Bash({ persistState: true });

  it("shows full overview by default", async () => {
    const result = await bash.exec("about");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ag-bash v");
    expect(result.stdout).toContain("ARCHITECTURE");
    expect(result.stdout).toContain("FEATURES");
    expect(result.stdout).toContain("QUICK START");
  });

  it("--version shows just version", async () => {
    const result = await bash.exec("about --version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("--features lists all features", async () => {
    const result = await bash.exec("about --features");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agent RunLoop");
    expect(result.stdout).toContain("Self-Healing");
    expect(result.stdout).toContain("MCP Server");
  });

  it("--architecture shows pipeline", async () => {
    const result = await bash.exec("about --architecture");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Parser");
    expect(result.stdout).toContain("AST");
    expect(result.stdout).toContain("Interpreter");
  });

  it("--help shows usage", async () => {
    const result = await bash.exec("about --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("show ag-bash features");
  });
});
