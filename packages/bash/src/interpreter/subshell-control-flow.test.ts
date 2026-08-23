import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

/**
 * `break` / `continue` inside a SUBSHELL that was spawned from a loop.
 *
 * A subshell is a separate process, so it cannot continue or break the parent's
 * loop. Real bash (arm64-darwin) terminates the SUBSHELL cleanly with status 0,
 * prints nothing to stderr, and leaves the parent loop running:
 *
 *   for i in 1 2; do ( continue; echo NOPE ); echo st=$?; done
 *   -> st=0 / st=0, and NOPE never appears.
 *
 * This is the oracle for the Oils spec case
 * `src/spec-tests/bash/cases/loop.test.sh::continue in subshell`
 * (`## OK dash/zsh/bash STDOUT:` variant).
 *
 * Three things went wrong before: the flow control was lost (the rest of the
 * subshell body ran), and the internal `SubshellExitError` sentinel surfaced in
 * user-visible stderr as `bash: continue: unexpected error: subshell exit`.
 */
describe("break/continue inside a subshell spawned from a loop", () => {
  it("terminates the subshell instead of running the rest of its body", async () => {
    const env = new Bash();
    const result = await env.exec(`for i in 1 2; do
  echo "> $i"
  ( if true; then continue; fi; echo "Should not print" )
  echo subshell status=$?
  echo ". $i"
done`);
    expect(result.stdout).toBe(
      "> 1\nsubshell status=0\n. 1\n> 2\nsubshell status=0\n. 2\n",
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("does not leak the internal subshell-exit sentinel to stderr", async () => {
    const env = new Bash();
    const result = await env.exec(`for i in 1; do ( continue ); done`);
    expect(result.stderr).not.toContain("subshell exit");
    expect(result.stderr).not.toContain("unexpected error");
    expect(result.stderr).toBe("");
  });

  it("terminates the subshell on break too, leaving the parent loop intact", async () => {
    const env = new Bash();
    const result = await env.exec(`for i in 1 2 3; do
  (
    if [ $i -eq 2 ]; then break; fi
    echo $i
  )
done
echo done`);
    expect(result.stdout).toBe("1\n3\ndone\n");
    expect(result.stderr).toBe("");
  });

  it("keeps the subshell status at 0", async () => {
    const env = new Bash();
    const result = await env.exec(`for i in 1 2; do
  ( break; echo NOPE )
  echo st=$?
done`);
    expect(result.stdout).toBe("st=0\nst=0\n");
    expect(result.stderr).toBe("");
  });

  it("still lets a loop INSIDE the subshell handle its own continue", async () => {
    const env = new Bash();
    const result = await env.exec(
      "( for j in a b; do continue; echo NO; done; echo after ); echo st=$?",
    );
    expect(result.stdout).toBe("after\nst=0\n");
    expect(result.stderr).toBe("");
  });

  it("still lets a loop INSIDE the subshell handle its own break", async () => {
    const env = new Bash();
    const result = await env.exec(
      "for i in 1 2; do ( for j in a b; do break; done; echo inner=$j ); done",
    );
    expect(result.stdout).toBe("inner=a\ninner=a\n");
    expect(result.stderr).toBe("");
  });

  // Real bash also prints "only meaningful in a `for', `while', or `until'
  // loop" here; this engine is silent. Only the status is asserted, so the test
  // neither enshrines that divergence nor demands a new warning.
  it("leaves break/continue outside any loop a status-0 no-op", async () => {
    const env = new Bash();
    const result = await env.exec(`( continue )
echo st=$?
( break )
echo st=$?`);
    expect(result.stdout).toBe("st=0\nst=0\n");
    expect(result.stderr).not.toContain("subshell exit");
  });
});
