import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

/**
 * Agent Scenario: Fork-Speculation (the headline moat)
 *
 * An AI agent has TWO candidate approaches to accomplish a task and is unsure
 * which is better. Instead of committing to one and risking a corrupted
 * sandbox, it speculatively forks the sandbox into isolated copy-on-write
 * branches, runs each approach in parallel, scores the outcomes, and keeps ONLY
 * the winner — re-applying it onto the real sandbox.
 *
 * This demonstrates the fork() + speculate() public API:
 *   - branches are fully isolated (no cross-contamination)
 *   - the parent sandbox is untouched during speculation
 *   - the agent picks a winner and commits it deterministically
 */
describe("Agent fork-speculation demo: try two approaches, keep the better one", () => {
  it("agent speculatively builds a release artifact two ways and keeps the winner", async () => {
    // The agent's sandbox: a tiny project it must "build" into /dist/out.txt.
    const agent = new Bash({
      files: {
        "/project/a.txt": "alpha\n",
        "/project/b.txt": "beta\n",
        "/project/c.txt": "gamma\n",
      },
    });
    await agent.exec("mkdir -p /dist", { persistState: true });

    type Candidate = {
      approach: string;
      score: number;
      lineCount: number;
      branch: Bash;
    };

    // Speculate: two competing build strategies, each in its own isolated fork.
    const candidates = await agent.speculate<Candidate>([
      // Approach A: concatenate only a.txt + b.txt (incomplete -> fewer lines).
      async (b) => {
        await b.exec("cat /project/a.txt /project/b.txt > /dist/out.txt");
        const built = await b.readFile("/dist/out.txt");
        const lineCount = built.trimEnd().split("\n").length;
        return {
          approach: "partial-concat",
          score: lineCount,
          lineCount,
          branch: b,
        };
      },
      // Approach B: concatenate ALL three files (complete -> more lines, wins).
      async (b) => {
        await b.exec(
          "cat /project/a.txt /project/b.txt /project/c.txt > /dist/out.txt",
        );
        const built = await b.readFile("/dist/out.txt");
        const lineCount = built.trimEnd().split("\n").length;
        return {
          approach: "full-concat",
          score: lineCount,
          lineCount,
          branch: b,
        };
      },
    ]);

    // The agent scores the branches and picks the winner (most complete build).
    const winner = candidates.reduce((best, c) =>
      c.score > best.score ? c : best,
    );
    expect(winner.approach).toBe("full-concat");
    expect(winner.lineCount).toBe(3);

    // CRITICAL: speculation never touched the real sandbox.
    await expect(agent.readFile("/dist/out.txt")).rejects.toThrow();

    // Keep the winner: re-run the winning approach on the real sandbox.
    await agent.exec(
      "cat /project/a.txt /project/b.txt /project/c.txt > /dist/out.txt",
    );
    const committed = await agent.readFile("/dist/out.txt");
    expect(committed).toBe("alpha\nbeta\ngamma\n");

    // The losing branch left no trace anywhere on the real sandbox.
    expect(committed).not.toBe("alpha\nbeta\n");
  });

  it("a single fork lets the agent dry-run a risky command before committing", async () => {
    const agent = new Bash();
    await agent.exec("echo keep-me > /important.txt", { persistState: true });

    // Dry-run a destructive command in an isolated fork first.
    const trial = await agent.fork();
    await trial.exec("rm -f /important.txt");
    const stillThereInParent = await agent.existsDirect("/important.txt");

    // The destructive op happened only in the fork; the real file survives.
    expect(await trial.existsDirect("/important.txt")).toBe(false);
    expect(stillThereInParent).toBe(true);
    expect(await agent.readFile("/important.txt")).toBe("keep-me\n");
  });
});
