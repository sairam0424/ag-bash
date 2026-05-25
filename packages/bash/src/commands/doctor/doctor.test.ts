import { describe, it, expect } from "vitest";
import { Bash } from "../../Bash.js";

describe("doctor", () => {
  const bash = new Bash({ persistState: true });

  it("--quick runs only core + filesystem checks", async () => {
    const result = await bash.exec("doctor --quick");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CORE ENGINE");
    expect(result.stdout).toContain("FILESYSTEM");
    expect(result.stdout).not.toContain("COMMANDS");
    expect(result.stdout).toContain("checks passed");
  });

  it("full doctor runs all check categories", async () => {
    const result = await bash.exec("doctor");
    expect(result.stdout).toContain("CORE ENGINE");
    expect(result.stdout).toContain("FILESYSTEM");
    expect(result.stdout).toContain("COMMANDS");
    expect(result.stdout).toContain("FEATURES");
    expect(result.stdout).toContain("OPTIONAL RUNTIMES");
    expect(result.stdout).toContain("checks passed");
  });

  it("core checks all pass", async () => {
    const result = await bash.exec("doctor --quick");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("FAILED");
  });

  it("--help shows usage", async () => {
    const result = await bash.exec("doctor --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("verify ag-bash environment");
  });

  it("shows version in header", async () => {
    const result = await bash.exec("doctor --quick");
    expect(result.stdout).toContain("doctor v");
  });
});
