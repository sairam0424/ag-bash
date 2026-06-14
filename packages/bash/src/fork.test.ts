import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";

/**
 * Fork-speculation moat tests.
 *
 * fork() returns a copy-on-write branch of the sandbox: the child shares
 * NOTHING mutable with the parent. Child mutations (env, cwd, functions,
 * filesystem writes) must be invisible to the parent, and vice versa.
 */
describe("Bash.fork() — copy-on-write isolation", () => {
  it("captures parent state into the child at fork time", async () => {
    const parent = new Bash();
    await parent.exec("export FOO=parent", { persistState: true });
    await parent.exec("echo seed > /seed.txt");

    const child = await parent.fork();

    // Child starts as an exact copy of the parent.
    expect((await child.exec("echo $FOO")).stdout).toBe("parent\n");
    expect(await child.readFile("/seed.txt")).toBe("seed\n");
  });

  it("child env mutations are INVISIBLE to the parent", async () => {
    const parent = new Bash();
    await parent.exec("export FOO=parent", { persistState: true });

    const child = await parent.fork();
    await child.exec("export FOO=child", { persistState: true });
    await child.exec("export NEW=childonly", { persistState: true });

    // Child sees its own mutation.
    expect((await child.exec("echo $FOO")).stdout).toBe("child\n");
    expect((await child.exec("echo $NEW")).stdout).toBe("childonly\n");

    // Parent is completely unchanged.
    expect((await parent.exec("echo $FOO")).stdout).toBe("parent\n");
    expect((await parent.exec("echo [$NEW]")).stdout).toBe("[]\n");
  });

  it("child filesystem writes are INVISIBLE to the parent", async () => {
    const parent = new Bash();
    await parent.exec("echo original > /file.txt");

    const child = await parent.fork();
    await child.exec("echo mutated > /file.txt");
    await child.exec("echo brandnew > /child-only.txt");

    // Child sees its own writes.
    expect(await child.readFile("/file.txt")).toBe("mutated\n");
    expect(await child.readFile("/child-only.txt")).toBe("brandnew\n");

    // Parent's filesystem is untouched.
    expect(await parent.readFile("/file.txt")).toBe("original\n");
    await expect(parent.readFile("/child-only.txt")).rejects.toThrow();
  });

  it("child cwd and function mutations are INVISIBLE to the parent", async () => {
    const parent = new Bash();
    await parent.exec("mkdir -p /work /other; cd /work", {
      persistState: true,
    });
    await parent.exec("greet() { echo parent-greet; }", { persistState: true });

    const child = await parent.fork();
    await child.exec("cd /other", { persistState: true });
    await child.exec("greet() { echo child-greet; }", { persistState: true });

    // Child mutated cwd + function.
    expect(child.getCwd()).toBe("/other");
    expect((await child.exec("greet")).stdout).toBe("child-greet\n");

    // Parent retains its own cwd + function.
    expect(parent.getCwd()).toBe("/work");
    expect((await parent.exec("greet")).stdout).toBe("parent-greet\n");
  });

  it("parent mutations after fork are INVISIBLE to the child", async () => {
    const parent = new Bash();
    await parent.exec("export X=1", { persistState: true });

    const child = await parent.fork();

    // Parent moves on independently after the fork point.
    await parent.exec("export X=2", { persistState: true });
    await parent.exec("echo parent-after > /after.txt");

    // Child still sees the fork-time snapshot.
    expect((await child.exec("echo $X")).stdout).toBe("1\n");
    await expect(child.readFile("/after.txt")).rejects.toThrow();
  });

  it("two forks from the same parent are independent of each other", async () => {
    const parent = new Bash();
    await parent.exec("export V=base", { persistState: true });

    const a = await parent.fork();
    const b = await parent.fork();

    await a.exec("export V=alpha", { persistState: true });
    await a.exec("echo a > /branch.txt");
    await b.exec("export V=beta", { persistState: true });
    await b.exec("echo b > /branch.txt");

    expect((await a.exec("echo $V")).stdout).toBe("alpha\n");
    expect((await b.exec("echo $V")).stdout).toBe("beta\n");
    expect(await a.readFile("/branch.txt")).toBe("a\n");
    expect(await b.readFile("/branch.txt")).toBe("b\n");

    // Parent unaffected by either branch.
    expect((await parent.exec("echo $V")).stdout).toBe("base\n");
    await expect(parent.readFile("/branch.txt")).rejects.toThrow();
  });
});

describe("Bash.speculate() — fork, try branches, pick a winner", () => {
  it("runs branches in isolated children and returns their results in order", async () => {
    const parent = new Bash();
    await parent.exec("export COUNTER=10", { persistState: true });

    const results = await parent.speculate([
      async (b) => {
        await b.exec("export COUNTER=20", { persistState: true });
        return Number.parseInt(
          (await b.exec("echo $COUNTER")).stdout.trim(),
          10,
        );
      },
      async (b) => {
        await b.exec("export COUNTER=30", { persistState: true });
        return Number.parseInt(
          (await b.exec("echo $COUNTER")).stdout.trim(),
          10,
        );
      },
    ]);

    expect(results).toEqual([20, 30]);

    // Parent state is untouched by speculation.
    expect((await parent.exec("echo $COUNTER")).stdout).toBe("10\n");
  });

  it("supports a fork / try / keep-the-winner flow", async () => {
    // Agent has two candidate approaches to produce /result.txt.
    // It speculatively runs both in isolated branches, scores them,
    // then commits ONLY the winning branch's effect onto the parent.
    const parent = new Bash();
    await parent.exec("echo input > /data.txt", { persistState: true });

    type Candidate = { label: string; score: number; output: string };

    const candidates = await parent.speculate<Candidate>([
      // Approach A: cheap but lower quality.
      async (b) => {
        await b.exec("wc -l < /data.txt > /result.txt");
        const output = (await b.readFile("/result.txt")).trim();
        return { label: "wc", score: 1, output };
      },
      // Approach B: produces a richer result -> higher score.
      async (b) => {
        await b.exec("tr a-z A-Z < /data.txt > /result.txt");
        const output = (await b.readFile("/result.txt")).trim();
        return { label: "tr-upper", score: 2, output };
      },
    ]);

    // Caller picks the winner.
    const winner = candidates.reduce((best, c) =>
      c.score > best.score ? c : best,
    );
    expect(winner.label).toBe("tr-upper");
    expect(winner.output).toBe("INPUT");

    // Parent never had /result.txt written during speculation.
    await expect(parent.readFile("/result.txt")).rejects.toThrow();

    // Keep the winner: re-apply its effect on the parent deterministically.
    await parent.exec("tr a-z A-Z < /data.txt > /result.txt");
    expect((await parent.readFile("/result.txt")).trim()).toBe("INPUT");
  });

  it("returns an empty array for zero branches", async () => {
    const parent = new Bash();
    const results = await parent.speculate([]);
    expect(results).toEqual([]);
  });
});
