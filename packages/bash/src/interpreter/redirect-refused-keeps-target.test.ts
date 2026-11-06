/**
 * A refused output redirection must leave its target alone.
 *
 * Compound commands, commands with no command word, and the `break`,
 * `continue`, `return` and `exit` builtins open (truncate) their redirect
 * targets up front, before anything runs, so the check that refuses the
 * redirect has to come first: under `set -C` an existing file must keep its
 * content, and a directory must stay a directory with its contents. A check
 * that reports the message but lets the truncation happen would lose data
 * without any visible symptom in the message or the exit status.
 *
 * Every expectation was checked against real bash 5.3.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

interface Context {
  readonly name: string;
  /** `@` stands for the redirection under test. */
  readonly template: string;
}

/** Command contexts that open their redirect targets up front. */
const CONTEXTS: readonly Context[] = [
  { name: "assignment only", template: "x=1 @" },
  { name: "bare redirect", template: "@" },
  { name: "subshell", template: "( echo hi ) @" },
  { name: "for loop", template: "for i in 1 2; do echo $i; done @" },
  {
    name: "c-style for loop",
    template: "for ((i=0;i<2;i++)); do echo $i; done @",
  },
  { name: "case", template: "case a in a) echo y;; esac @" },
  { name: "[[ ]]", template: "[[ -n x ]] @" },
  { name: "(( ))", template: "(( 1 )) @" },
  { name: "group", template: "{ echo hi; } @" },
  { name: "simple command", template: "echo hi @" },
  { name: "break", template: "for i in 1; do break @; done" },
  { name: "continue", template: "for i in 1; do continue @; done" },
  { name: "return", template: "f() { return 3 @; }; f" },
];

/** Output redirection forms that truncate their target. */
const FORMS: readonly string[] = [">", "&>", ">&", "2>"];

const CASES: ReadonlyArray<readonly [string, string, string]> =
  CONTEXTS.flatMap((context) =>
    FORMS.map(
      (form) =>
        [
          context.name,
          form,
          context.template.replace("@", `${form} TARGET`),
        ] as const,
    ),
  );

describe("a refused noclobber redirect leaves the existing file untouched", () => {
  it.each(CASES)("%s, %s", async (_context, _form, script) => {
    const env = new Bash();
    const result = await env.exec(
      `echo old > existing; set -C; ${script.replace("TARGET", "existing")}; ` +
        'echo "rc=$? file=[$(cat existing)]"',
    );
    // A group or simple command whose only redirect is `2>` has already run
    // (and printed) by the time the redirect is refused, so only the last line
    // is pinned: the status and the file's content.
    expect(result.stdout).toMatch(/(?:^|\n)rc=1 file=\[old\]\n$/);
    expect(result.stderr).toContain("existing: cannot overwrite existing file");
  });

  it("{fd}> leaves it untouched too", async () => {
    const env = new Bash();
    const result = await env.exec(
      'echo old > existing; set -C; exec {fd}> existing; echo "rc=$? file=[$(cat existing)]"',
    );
    expect(result.stdout).toBe("rc=1 file=[old]\n");
    expect(result.stderr).toContain("cannot overwrite existing file");
  });

  it("an earlier redirection that was allowed is not undone, and the refused one stops the list", async () => {
    const env = new Bash();
    const result = await env.exec(
      'echo old > existing; echo keep > other; set -C; x=1 > fresh > existing > other; echo "rc=$? existing=[$(cat existing)] other=[$(cat other)]"; test -f fresh',
    );
    expect(result.stdout).toBe("rc=1 existing=[old] other=[keep]\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("the same redirects do truncate when >| overrides noclobber", () => {
  // These make the cases above meaningful: the file is changed when the
  // redirect is allowed, so "unchanged" really shows the refusal held.
  it.each([
    ["assignment only", "x=1 >| existing", ""],
    ["subshell", "( echo hi ) >| existing", "hi"],
    ["for loop", "for i in 1 2; do echo $i; done >| existing", "1\n2"],
    ["case", "case a in a) echo y;; esac >| existing", "y"],
    ["[[ ]]", "[[ -n x ]] >| existing", ""],
    ["(( ))", "(( 1 )) >| existing", ""],
  ])("%s", async (_name, script, expected) => {
    const env = new Bash();
    const result = await env.exec(
      `echo old > existing; set -C; ${script}; echo "rc=$? file=[$(cat existing)]"`,
    );
    expect(result.stdout).toBe(`rc=0 file=[${expected}]\n`);
    expect(result.stderr).toBe("");
  });
});

describe("a refused directory-target redirect leaves the directory untouched", () => {
  const DIRECTORY_FORMS: readonly string[] = [">", ">|", "&>", ">&", "2>"];
  const DIRECTORY_CASES: ReadonlyArray<readonly [string, string, string]> =
    CONTEXTS.flatMap((context) =>
      DIRECTORY_FORMS.map(
        (form) =>
          [
            context.name,
            form,
            context.template.replace("@", `${form} adir`),
          ] as const,
      ),
    );

  it.each(DIRECTORY_CASES)("%s, %s", async (_context, _form, script) => {
    const env = new Bash();
    const result = await env.exec(
      `mkdir adir; echo keep > adir/inner; ${script}; ` +
        'echo "rc=$? kind=$(test -d adir && echo dir || echo other) inner=[$(cat adir/inner)]"',
    );
    expect(result.stdout).toMatch(/(?:^|\n)rc=1 kind=dir inner=\[keep\]\n$/);
    expect(result.stderr).toContain("adir: Is a directory");
  });

  it.each([">", ">|", "&>"])("{fd}%s", async (form) => {
    const env = new Bash();
    const result = await env.exec(
      `mkdir adir; echo keep > adir/inner; exec {fd}${form} adir; ` +
        'echo "rc=$? kind=$(test -d adir && echo dir || echo other) inner=[$(cat adir/inner)] fd=${fd-unset}"',
    );
    expect(result.stdout).toBe("rc=1 kind=dir inner=[keep] fd=unset\n");
    expect(result.stderr).toContain("adir: Is a directory");
  });
});
