/**
 * R1 live-wiring test for the DestructiveStage.
 *
 * The DestructiveStage class is exported and unit-tested in isolation, but the
 * SECURITY-RELEVANT property is that it actually runs on the LIVE exec path. If
 * buildExecutionPipeline() forgets to add the stage, the gate silently never
 * fires — a destructive command executes with NO observation and NO warning.
 *
 * These tests run a destructive command through `new Bash().exec(...)` and
 * assert the typed destructive Observation + stderr warning are present on the
 * result. Under the default WARN policy the command STILL executes in the
 * sandbox VFS (non-breaking) — only the typed warning rides along.
 *
 * Without the `addStage(new DestructiveStage(...))` wiring in Bash.ts these
 * assertions FAIL (no destructive observation is produced), which is exactly
 * the regression this test guards against.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("DestructiveStage — live exec-path wiring (R1)", () => {
  it("emits a destructive Observation + stderr warning under default WARN policy", async () => {
    const bash = new Bash();
    const result = await bash.exec("rm -rf /");

    const destructive = (result.observations ?? []).filter(
      (o) => o.type === "destructive",
    );
    expect(destructive.length).toBeGreaterThan(0);
    expect(destructive[0]?.command).toBe("rm");
    expect(destructive[0]?.code).toBeTruthy();
    expect(destructive[0]?.confidence).toBe(1);

    // WARN is non-blocking: the warning line is surfaced on stderr.
    expect(result.stderr).toContain("destructive command detected");
  });

  it("catches structural obfuscation via command substitution under WARN", async () => {
    const bash = new Bash();
    const result = await bash.exec("rm -rf $(echo /)");

    const destructive = (result.observations ?? []).filter(
      (o) => o.type === "destructive",
    );
    expect(destructive.length).toBeGreaterThan(0);
    expect(result.stderr).toContain("destructive command detected");
  });

  it("BLOCK policy short-circuits with a non-zero result and no interpretation", async () => {
    const bash = new Bash();
    const result = await bash.exec("rm -rf /", { destructivePolicy: "block" });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("destructive command refused");
    const destructive = (result.observations ?? []).filter(
      (o) => o.type === "destructive",
    );
    expect(destructive.length).toBeGreaterThan(0);
  });

  it("ALLOW policy disables the gate — no destructive observation", async () => {
    const bash = new Bash();
    const result = await bash.exec("rm -rf /", { destructivePolicy: "allow" });

    const destructive = (result.observations ?? []).filter(
      (o) => o.type === "destructive",
    );
    expect(destructive.length).toBe(0);
    expect(result.stderr).not.toContain("destructive command detected");
  });
});
