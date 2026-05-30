import { Bash } from "@ag-bash/bash";
import { describe, expect, it } from "vitest";
import {
  type ForkSpeculateSummary,
  runForkSpeculate,
} from "./fork-speculate.js";

function parseSummary(text: string): ForkSpeculateSummary {
  return JSON.parse(text) as ForkSpeculateSummary;
}

describe("runForkSpeculate (MCP fork-speculation tool)", () => {
  it("runs branches in isolation and leaves the persistent shell untouched", async () => {
    const bash = new Bash();
    await bash.exec("export V=base", { persistState: true });
    await bash.exec("echo seed > /f.txt", { persistState: true });

    const result = await runForkSpeculate(bash, {
      branches: [
        ["export V=alpha", "echo alpha > /f.txt", "echo $V"],
        ["export V=beta", "echo beta > /f.txt", "echo $V"],
      ],
    });

    expect(result.isError).toBeFalsy();
    const summary = parseSummary(result.content[0].text);
    expect(summary.committed).toBeNull();
    expect(summary.branches).toHaveLength(2);
    expect(summary.branches[0].stdout.trim().endsWith("alpha")).toBe(true);
    expect(summary.branches[1].stdout.trim().endsWith("beta")).toBe(true);
    expect(summary.branches[0].exitCode).toBe(0);

    // Persistent shell is untouched by speculation.
    expect((await bash.exec("echo $V")).stdout).toBe("base\n");
    expect(await bash.readFile("/f.txt")).toBe("seed\n");
  });

  it("commits exactly the winning branch when keepWinner is set", async () => {
    const bash = new Bash();
    await bash.exec("echo input > /data.txt", { persistState: true });

    const result = await runForkSpeculate(bash, {
      branches: [
        ["wc -l < /data.txt > /result.txt"],
        ["tr a-z A-Z < /data.txt > /result.txt"],
      ],
      keepWinner: 1,
    });

    const summary = parseSummary(result.content[0].text);
    expect(summary.committed).toBe(1);

    // Winning branch's effect is committed to the persistent shell.
    expect((await bash.readFile("/result.txt")).trim()).toBe("INPUT");
  });

  it("reports a non-zero exit code and stops the branch early on failure", async () => {
    const bash = new Bash();

    const result = await runForkSpeculate(bash, {
      branches: [["false", "echo should-not-run"]],
    });

    const summary = parseSummary(result.content[0].text);
    expect(summary.branches[0].exitCode).not.toBe(0);
    expect(summary.branches[0].stdout).not.toContain("should-not-run");
  });

  it("rejects an empty branches array", async () => {
    const bash = new Bash();
    const result = await runForkSpeculate(bash, { branches: [] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("non-empty array");
  });

  it("rejects an out-of-range keepWinner index", async () => {
    const bash = new Bash();
    const result = await runForkSpeculate(bash, {
      branches: [["true"]],
      keepWinner: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("out of range");
  });

  it("rejects more than 16 branches", async () => {
    const bash = new Bash();
    const branches = Array.from({ length: 17 }, () => ["true"]);
    const result = await runForkSpeculate(bash, { branches });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("too many branches");
  });
});
