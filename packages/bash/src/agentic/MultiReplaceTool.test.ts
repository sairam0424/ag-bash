/**
 * ag_multi_edit is `isDestructive: true` and writes via
 * bash.writeFileDirect. It must therefore obey the plan-mode gate that
 * buildTool installs for destructive tools (Tool.ts), exactly like ag_edit
 * and write_file do.
 *
 * Both halves matter: a tool that is denied in plan mode but also broken in
 * execute mode is not "secured", it is disabled. Every deny assertion below
 * has a matching execute-mode control.
 */
import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { MultiReplaceTool } from "./MultiReplaceTool.js";

const SEED = "echo seed > /s.txt";

/** Seeds /s.txt, primes the staleness cache, and enters plan mode. */
async function planModeBash(): Promise<Bash> {
  const bash = new Bash();
  await bash.exec(SEED);
  // Satisfies MultiReplaceTool's own staleness check, so a failure to deny
  // cannot be mistaken for a stale-edit rejection.
  await bash.readFileDirect("/s.txt");
  await bash.exec("ag-plan enter");
  return bash;
}

describe("ag_multi_edit plan-mode gate", () => {
  it("DENIES the write in plan mode and leaves the file untouched", async () => {
    const bash = await planModeBash();

    const result = String(
      await bash.toolbox.callTool(bash, "ag_multi_edit", {
        path: "/s.txt",
        chunks: [{ target: "seed", replacement: "pwned" }],
      }),
    );

    expect(result).toContain("Permission Denied");
    expect(await bash.fs.readFile("/s.txt", "utf8")).toBe("seed\n");
  });

  it("still applies replacements in execute mode (tool not broken)", async () => {
    const bash = new Bash();
    await bash.exec(SEED);
    await bash.readFileDirect("/s.txt");

    const result = String(
      await bash.toolbox.callTool(bash, "ag_multi_edit", {
        path: "/s.txt",
        chunks: [{ target: "seed", replacement: "pwned" }],
      }),
    );

    expect(result).toContain("Successfully applied 1 replacements");
    expect(await bash.fs.readFile("/s.txt", "utf8")).toBe("pwned\n");
  });

  it("does not hardcode an allow: checkPermissions denies while getMode() is plan", async () => {
    // Asserts the gate directly, not just through the executor, so a future
    // re-introduced `{ behavior: "allow" }` override fails here too.
    const bash = await planModeBash();
    const decision = await MultiReplaceTool.checkPermissions(bash, {
      path: "/s.txt",
      chunks: [{ target: "seed", replacement: "pwned" }],
    });
    expect(decision.behavior).toBe("deny");
  });

  it("rejects malformed input instead of passing it to execute", async () => {
    const bash = new Bash();
    await bash.exec(SEED);

    // `chunks` is required and must be an array of {target, replacement}.
    const result = String(
      await bash.toolbox.callTool(bash, "ag_multi_edit", {
        path: "/s.txt",
        chunks: "seed",
      }),
    );

    expect(result).toContain("Validation Error");
    expect(await bash.fs.readFile("/s.txt", "utf8")).toBe("seed\n");
  });
});
