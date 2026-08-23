/**
 * Pipeline stage redirections must survive the pipeline fast paths.
 *
 * `pipeline-execution.ts` has two optimizations that fabricate a stage result
 * without calling `executeCommand`:
 *   - Optimization B: the `wc -l` newline counter.
 *   - Optimization D: the empty-stdin short-circuit.
 *
 * Redirections are applied *inside* `executeCommand` (input redirections
 * override the piped stdin; output redirections divert stdout/stderr to a
 * file). Fabricating a result therefore silently DROPS every redirection
 * attached to that stage — the output file is never created and `< file` /
 * here-doc stdin overrides are ignored.
 *
 * Reference behaviour below was captured from /bin/bash on this machine.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("Optimization B (wc -l fast path) preserves stage redirections", () => {
  it("`wc -l > file` writes the count to the file", async () => {
    // /bin/bash: `printf 'a\nb\n' | wc -l > o1.txt` -> o1.txt contains the count
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\n' | wc -l > /out.txt");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(await bash.existsDirect("/out.txt")).toBe(true);
    expect(await bash.readFile("/out.txt")).toBe("2\n");
  });

  it("`wc -l >> file` appends the count to an existing file", async () => {
    const bash = new Bash({ files: { "/app.txt": "PRE\n" } });
    const result = await bash.exec("printf 'a\\nb\\n' | wc -l >> /app.txt");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(await bash.readFile("/app.txt")).toBe("PRE\n2\n");
  });

  it("`wc -l 2> file` creates the (empty) stderr file and keeps stdout", async () => {
    // /bin/bash: `printf '' | cat 2> d5.txt` creates a zero-length d5.txt
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\n' | wc -l 2> /err.txt");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2\n");
    expect(await bash.existsDirect("/err.txt")).toBe(true);
    expect(await bash.readFile("/err.txt")).toBe("");
  });

  it("a here-doc on the `wc -l` stage overrides the piped stdin", async () => {
    // /bin/bash: 4 piped lines, 2 here-doc lines -> prints 2
    const bash = new Bash();
    const result = await bash.exec(
      "printf 'a\\nb\\nc\\nd\\n' | wc -l << EOF\nx\ny\nEOF\n",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2\n");
  });

  it("`< file` on the `wc -l` stage overrides the piped stdin", async () => {
    // /bin/bash: `printf 'a\nb\nc\n' | wc -l < f.txt` (f.txt = 1 line) -> 1
    const bash = new Bash({ files: { "/ref.txt": "REF\n" } });
    const result = await bash.exec("printf 'a\\nb\\nc\\n' | wc -l < /ref.txt");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1\n");
  });

  it("`<<< here-string` on the `wc -l` stage overrides the piped stdin", async () => {
    const bash = new Bash();
    const result = await bash.exec(
      "printf 'a\\nb\\nc\\nd\\n' | wc -l <<< 'only one'",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1\n");
  });

  it("a prefix assignment on the `wc -l` stage still runs its expansion", async () => {
    // /bin/bash: `printf 'a\nb\n' | FOO=$(echo hi > side.txt; echo v) wc -l`
    // prints 2 AND creates side.txt — the assignment's command substitution runs.
    const bash = new Bash();
    const result = await bash.exec(
      "printf 'a\\nb\\n' | FOO=$(echo hi > /side.txt; echo v) wc -l",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2\n");
    expect(await bash.existsDirect("/side.txt")).toBe(true);
    expect(await bash.readFile("/side.txt")).toBe("hi\n");
  });

  it("control: `wc -c > file` (not on the fast path) already redirects", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\n' | wc -c > /ctl.txt");

    expect(result.stdout).toBe("");
    expect(await bash.readFile("/ctl.txt")).toBe("4\n");
  });

  it("unredirected `wc -l` still counts through the pipe", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\nc\\n' | wc -l");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("3\n");
  });
});

describe("Optimization D (empty-stdin short-circuit) preserves stage redirections", () => {
  it("`> file` on an empty-stdin stage still creates the file", async () => {
    // /bin/bash: `printf '' | cat > d1.txt` creates a zero-length d1.txt
    const bash = new Bash();
    const result = await bash.exec("printf '' | cat > /d1.txt");

    expect(result.exitCode).toBe(0);
    expect(await bash.existsDirect("/d1.txt")).toBe(true);
    expect(await bash.readFile("/d1.txt")).toBe("");
  });

  it("`> file` on an empty-stdin stage truncates an existing file", async () => {
    // /bin/bash: `printf 'OLD\n' > d6.txt; printf '' | cat > d6.txt` -> d6.txt empty
    const bash = new Bash({ files: { "/d6.txt": "OLD\n" } });
    const result = await bash.exec("printf '' | cat > /d6.txt");

    expect(result.exitCode).toBe(0);
    expect(await bash.readFile("/d6.txt")).toBe("");
  });

  it("`>> file` on an empty-stdin stage leaves an existing file intact", async () => {
    const bash = new Bash({ files: { "/d2.txt": "KEEP\n" } });
    const result = await bash.exec("printf '' | cat >> /d2.txt");

    expect(result.exitCode).toBe(0);
    expect(await bash.readFile("/d2.txt")).toBe("KEEP\n");
  });

  it("`2> file` on an empty-stdin stage still creates the stderr file", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '' | cat 2> /d5.txt");

    expect(result.exitCode).toBe(0);
    expect(await bash.existsDirect("/d5.txt")).toBe(true);
    expect(await bash.readFile("/d5.txt")).toBe("");
  });

  it("`< file` on an empty-stdin stage supplies stdin from the file", async () => {
    // /bin/bash: `printf '' | cat < f.txt` -> prints the file contents
    const bash = new Bash({ files: { "/ref.txt": "REF\n" } });
    const result = await bash.exec("printf '' | cat < /ref.txt");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("REF\n");
  });

  it("a here-doc on an empty-stdin stage supplies stdin", async () => {
    // /bin/bash: `printf '' | cat << EOF\nHD\nEOF` -> prints HD
    const bash = new Bash();
    const result = await bash.exec("printf '' | cat << EOF\nHD\nEOF\n");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("HD\n");
  });

  it("a here-string on an empty-stdin stage supplies stdin", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '' | cat <<< 'HS'");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("HS\n");
  });

  it("`&> file` on an empty-stdin stage still creates the file", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '' | cat &> /d7.txt");

    expect(result.exitCode).toBe(0);
    expect(await bash.existsDirect("/d7.txt")).toBe(true);
    expect(await bash.readFile("/d7.txt")).toBe("");
  });

  it("a prefix assignment on an empty-stdin stage still runs its expansion", async () => {
    // /bin/bash: `printf '' | FOO=$(echo hi > side2.txt; echo v) cat`
    // creates side2.txt even though cat sees empty stdin.
    const bash = new Bash();
    const result = await bash.exec(
      "printf '' | FOO=$(echo hi > /side2.txt; echo v) cat",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(await bash.existsDirect("/side2.txt")).toBe(true);
    expect(await bash.readFile("/side2.txt")).toBe("hi\n");
  });

  it("control: `wc -c > file` on empty stdin (exempt command) already redirects", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '' | wc -c > /ctl2.txt");

    expect(result.stdout).toBe("");
    expect(await bash.readFile("/ctl2.txt")).toBe("0\n");
  });

  it("`od` on empty stdin: short-circuit and real path agree on empty output", async () => {
    // Documents why `od` is deliberately NOT in EMPTY_STDIN_PRODUCES_OUTPUT.
    // /bin/bash on darwin (BSD od) prints nothing for `printf '' | od`, and
    // ag-bash's own od returns "" for empty input (no address line is emitted
    // when there are zero bytes). The `< /empty.txt` variant carries a
    // redirection, so it takes the REAL execution path — proving both paths
    // agree and that exempting `od` would be behaviour-neutral noise.
    const bash = new Bash({ files: { "/empty.txt": "" } });

    const shortCircuited = await bash.exec("printf '' | od");
    expect(shortCircuited.stdout).toBe("");
    expect(shortCircuited.exitCode).toBe(0);

    const realPath = await bash.exec("printf 'ignored' | od < /empty.txt");
    expect(realPath.stdout).toBe("");
    expect(realPath.exitCode).toBe(0);
  });

  it("unredirected empty-stdin filter still yields empty output", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '' | cat");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("empty-stdin short-circuit still reports the stage exit code path", async () => {
    // grep on empty input legitimately emits nothing and exits 1 in real bash,
    // but the short-circuit fabricates exit 0. Guard the documented current
    // behaviour of the unredirected fast path so the fix does not shift it.
    const bash = new Bash();
    const result = await bash.exec("printf '' | sort");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});
