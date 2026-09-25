/**
 * R1 live-wiring test for the DestructiveStage.
 *
 * The DestructiveStage class is exported and unit-tested in isolation, but the
 * SECURITY-RELEVANT property is that it actually runs on the LIVE exec path. If
 * buildExecutionPipeline() forgets to add the stage, the gate silently never
 * fires — a destructive command executes with NO observation and NO warning.
 *
 * As of the Phase 7 default-flip, `new Bash()` with no explicit
 * `destructivePolicy` option now BLOCKS destructive commands by default
 * (short-circuits with exit code 126, never reaches interpret). The WARN
 * behavior (typed Observation + stderr warning, command still executes) is
 * still fully supported — it just now requires opting in explicitly via
 * `{ destructivePolicy: "warn" }`.
 *
 * Without the `addStage(new DestructiveStage(...))` wiring in Bash.ts these
 * assertions FAIL (no destructive observation is produced), which is exactly
 * the regression this test guards against.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("DestructiveStage — live exec-path wiring (R1)", () => {
  it("BLOCKS by default (no explicit destructivePolicy) with exit code 126", async () => {
    const bash = new Bash();
    const result = await bash.exec("rm -rf /");

    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("destructive command refused");
    const destructive = (result.observations ?? []).filter(
      (o) => o.type === "destructive",
    );
    expect(destructive.length).toBeGreaterThan(0);
    expect(destructive[0]?.command).toBe("rm");
    expect(destructive[0]?.code).toBeTruthy();
    expect(destructive[0]?.confidence).toBe(1);
  });

  it("emits a destructive Observation + stderr warning under explicit WARN policy", async () => {
    const bash = new Bash();
    const result = await bash.exec("rm -rf /", { destructivePolicy: "warn" });

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

  it("catches structural obfuscation via command substitution under explicit WARN", async () => {
    const bash = new Bash();
    const result = await bash.exec("rm -rf $(echo /)", {
      destructivePolicy: "warn",
    });

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
