/**
 * A failing output redirection is an ordinary shell failure: exec() must
 * resolve with a non-zero exit status and bash's message on stderr. It must
 * never reject with a raw filesystem error.
 *
 * This matrix crosses every redirect form with every command context for the
 * three ways a redirect target can be unusable on the default in-memory
 * filesystem (missing parent directory, parent is a file, target is a
 * directory). Expected messages and exit statuses were checked against real
 * bash 5.3.
 *
 * Regression for the long-fuzz counterexample "combined malformed" (seed
 * 1736057820, run 7094): an assignment-only command with an output redirect
 * to a path whose parent does not exist made exec() reject with ENOENT.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import type { BashExecResult } from "../types.js";

/** How strictly a redirect form is checked once its target is unusable. */
type Expectation =
  /** bash fails with the target's own message (and so must we). */
  | "message"
  /** bash fails, but ag-bash's wording differs (e.g. "ambiguous redirect"). */
  | "failure"
  /** ag-bash does not open the file at all; only "never rejects" is checked. */
  | "none";

interface RedirectForm {
  readonly name: string;
  readonly build: (target: string) => string;
  /** Text that must follow the whole command line (a here-document body). */
  readonly trailer?: string;
  readonly expectation: Expectation;
  /**
   * When set, the form is only checked strictly in these contexts. The others
   * never open the file at all (descriptor variables are only processed for
   * simple commands and groups), so they are held to "never rejects".
   */
  readonly strictIn?: readonly string[];
}

interface CommandContext {
  readonly name: string;
  readonly build: (redirect: string) => string;
  /** Whether the whole script's exit status is the failing redirect's. */
  readonly failsExit: boolean;
  /**
   * False for compound commands whose output redirections the interpreter
   * ignores altogether (`if`, `while`, `until`: a separate, existing bug, the
   * output is not written to the file either). Held to "never rejects" only.
   */
  readonly appliesRedirections?: boolean;
  /** Forms (by name) that this context does not handle; "never rejects" only. */
  readonly looseForms?: readonly string[];
}

interface TargetCase {
  readonly name: string;
  readonly path: string;
  readonly message: string;
}

const SETUP = "echo seed > afile; mkdir adir";

const TARGETS: readonly TargetCase[] = [
  {
    name: "missing parent directory (relative)",
    path: "nodir/f",
    message: "No such file or directory",
  },
  {
    name: "missing parent directory (absolute)",
    path: "/nonexistent/dir/f",
    message: "No such file or directory",
  },
  {
    name: "parent is a regular file",
    path: "afile/f",
    message: "Not a directory",
  },
  {
    name: "target is a directory",
    path: "adir",
    message: "Is a directory",
  },
];

/** Contexts that process `{fd}` redirections (simple commands and groups). */
const FD_VARIABLE_CONTEXTS: readonly string[] = [
  "echo",
  "printf",
  "colon",
  "true",
  "cd",
  "export",
  "declare",
  "exec with only redirections",
  "eval",
  "command",
  "builtin",
  "cat",
  "function call",
  "group",
  "left side of a pipeline",
  "right side of a pipeline",
  "group on the left of a pipeline",
  "same redirect twice in a list",
];

const FORMS: readonly RedirectForm[] = [
  { name: ">", build: (t) => `> ${t}`, expectation: "message" },
  { name: ">>", build: (t) => `>> ${t}`, expectation: "message" },
  { name: ">|", build: (t) => `>| ${t}`, expectation: "message" },
  { name: "2>", build: (t) => `2> ${t}`, expectation: "message" },
  { name: "2>>", build: (t) => `2>> ${t}`, expectation: "message" },
  { name: "&>", build: (t) => `&> ${t}`, expectation: "message" },
  { name: "&>>", build: (t) => `&>> ${t}`, expectation: "message" },
  { name: ">&", build: (t) => `>& ${t}`, expectation: "message" },
  { name: "1>&", build: (t) => `1>& ${t}`, expectation: "message" },
  { name: "2>&", build: (t) => `2>& ${t}`, expectation: "failure" },
  { name: "3>", build: (t) => `3> ${t}`, expectation: "message" },
  { name: "3>>", build: (t) => `3>> ${t}`, expectation: "none" },
  { name: "{fd}>", build: (t) => `{fd}> ${t}`, expectation: "message" },
  {
    name: "{fd}>>",
    build: (t) => `{fd}>> ${t}`,
    expectation: "message",
    strictIn: FD_VARIABLE_CONTEXTS,
  },
  { name: "<>", build: (t) => `<> ${t}`, expectation: "none" },
  { name: "3<>", build: (t) => `3<> ${t}`, expectation: "none" },
  {
    name: "> then another >",
    build: (t) => `> ${t} > second`,
    expectation: "message",
  },
  { name: "<<< with >", build: (t) => `<<< hi > ${t}`, expectation: "message" },
  {
    name: "heredoc with >",
    build: (t) => `<<EOF > ${t}`,
    trailer: "\nhi\nEOF",
    expectation: "message",
  },
];

const CONTEXTS: readonly CommandContext[] = [
  { name: "bare redirect", build: (r) => r, failsExit: true },
  { name: "assignment only", build: (r) => `x=1 ${r}`, failsExit: true },
  {
    name: "several assignments",
    build: (r) => `x=1 y=2 ${r}`,
    failsExit: true,
  },
  { name: "array assignment", build: (r) => `a=(1 2) ${r}`, failsExit: true },
  {
    name: "assignment from command substitution",
    build: (r) => `x=$(echo hi) ${r}`,
    failsExit: true,
  },
  { name: "echo", build: (r) => `echo hi ${r}`, failsExit: true },
  { name: "printf", build: (r) => `printf hi ${r}`, failsExit: true },
  { name: "colon", build: (r) => `: ${r}`, failsExit: true },
  { name: "true", build: (r) => `true ${r}`, failsExit: true },
  { name: "cd", build: (r) => `cd . ${r}`, failsExit: true },
  { name: "export", build: (r) => `export z=9 ${r}`, failsExit: true },
  { name: "declare", build: (r) => `declare z=9 ${r}`, failsExit: true },
  {
    name: "exec with only redirections",
    build: (r) => `exec ${r}`,
    failsExit: true,
  },
  { name: "eval", build: (r) => `eval 'echo hi' ${r}`, failsExit: true },
  { name: "command", build: (r) => `command echo hi ${r}`, failsExit: true },
  { name: "builtin", build: (r) => `builtin echo hi ${r}`, failsExit: true },
  { name: "cat", build: (r) => `cat afile ${r}`, failsExit: true },
  {
    name: "function call",
    build: (r) => `f() { echo hi; }; f ${r}`,
    failsExit: true,
  },
  {
    name: "function definition with redirection",
    build: (r) => `f() { echo hi; } ${r}; f`,
    failsExit: true,
    looseForms: ["{fd}>", "{fd}>>"],
  },
  { name: "subshell", build: (r) => `( echo hi ) ${r}`, failsExit: true },
  { name: "group", build: (r) => `{ echo hi; } ${r}`, failsExit: true },
  {
    name: "for loop",
    build: (r) => `for i in 1 2; do echo $i; done ${r}`,
    failsExit: true,
  },
  {
    name: "c-style for loop",
    build: (r) => `for ((i=0;i<1;i++)); do :; done ${r}`,
    failsExit: true,
  },
  {
    name: "while loop",
    build: (r) => `while false; do :; done ${r}`,
    failsExit: true,
    appliesRedirections: false,
  },
  {
    name: "until loop",
    build: (r) => `until true; do :; done ${r}`,
    failsExit: true,
    appliesRedirections: false,
  },
  {
    name: "if statement",
    build: (r) => `if true; then echo hi; fi ${r}`,
    failsExit: true,
    appliesRedirections: false,
  },
  {
    name: "case statement",
    build: (r) => `case x in x) echo hi;; esac ${r}`,
    failsExit: true,
  },
  { name: "[[ ]]", build: (r) => `[[ -n x ]] ${r}`, failsExit: true },
  { name: "(( ))", build: (r) => `(( 1 )) ${r}`, failsExit: true },
  {
    name: "left side of a pipeline",
    build: (r) => `echo hi ${r} | cat`,
    failsExit: false,
  },
  {
    name: "right side of a pipeline",
    build: (r) => `echo hi | cat ${r}`,
    failsExit: true,
  },
  {
    name: "assignment on the left of a pipeline",
    build: (r) => `x=1 ${r} | cat`,
    failsExit: false,
  },
  {
    name: "assignment on the right of a pipeline",
    build: (r) => `echo hi | x=1 ${r}`,
    failsExit: true,
  },
  {
    name: "group on the left of a pipeline",
    build: (r) => `{ echo hi; } ${r} | cat`,
    failsExit: false,
  },
  {
    name: "assignment before && / ||",
    build: (r) => `x=1 ${r} && echo yes || echo no`,
    failsExit: false,
  },
  {
    name: "same redirect twice in a list",
    build: (r) => `echo a ${r}; echo b ${r}`,
    failsExit: true,
  },
];

async function runIn(
  script: string,
): Promise<{ result: BashExecResult; filesystemIntact: boolean }> {
  const env = new Bash();
  try {
    await env.exec(SETUP);
    const result = await env.exec(script);
    // A failed redirect must not create missing parents, nor turn a
    // directory into a file.
    const probe = await env.exec(
      "test -d adir && test -f afile && test ! -e nodir && test ! -e /nonexistent",
    );
    return { result, filesystemIntact: probe.exitCode === 0 };
  } finally {
    env.destroy();
  }
}

async function checkCase(
  context: CommandContext,
  form: RedirectForm,
  target: TargetCase,
): Promise<string[]> {
  const script = `${context.build(form.build(target.path))}${form.trailer ?? ""}`;
  const label = JSON.stringify(script);
  let outcome: Awaited<ReturnType<typeof runIn>>;
  try {
    outcome = await runIn(script);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [`${label}: exec() rejected with: ${reason}`];
  }

  const problems: string[] = [];
  const { result, filesystemIntact } = outcome;
  if (!filesystemIntact) {
    problems.push(`${label}: left the filesystem changed`);
  }
  const strict =
    context.appliesRedirections !== false &&
    context.looseForms?.includes(form.name) !== true &&
    (form.strictIn === undefined || form.strictIn.includes(context.name));
  if (!strict || form.expectation === "none") {
    return problems;
  }
  if (context.failsExit && result.exitCode === 0) {
    problems.push(`${label}: exit status was 0`);
  }
  if (
    form.expectation === "message" &&
    !result.stderr.includes(target.message)
  ) {
    problems.push(
      `${label}: stderr lacks "${target.message}": ${JSON.stringify(result.stderr)}`,
    );
  }
  if (form.expectation === "failure" && result.stderr === "") {
    problems.push(`${label}: stderr was empty`);
  }
  return problems;
}

/**
 * Further syntax around the same failure. These only have to resolve: process
 * substitution is rejected by the parser (a syntax error result) and the
 * descriptor-duplication forms combine a failing target with other redirects.
 */
const OTHER_SCRIPTS: readonly string[] = [
  "echo hi > >(cat > nodir/f)",
  "cat <(echo hi) > nodir/f",
  "x=1 > >(cat)",
  "cat <<-EOF > nodir/f\n\thi\nEOF",
  "x=1 <<-EOF > nodir/f\n\thi\nEOF",
  "echo hi 2>&1 > nodir/f",
  "echo hi > nodir/f 2>&1",
  "echo hi >&2 2> nodir/f",
  "exec 3>&1 > nodir/f",
  "exec 3>&1; echo hi >&3 > nodir/f",
  "x=1 > /dev/null/child",
  "echo hi > /dev/null/child",
  "x=1 > $'\\x9c'/f",
  "x=1 > a/b/c/d/e/f",
  "x=1 > nodir/../nodir2/f",
  "for i in 1 2; do x=1 > nodir/f; done",
  "f() { x=1 > nodir/f; }; f; f",
  "x=$(y=1 > nodir/f; echo $?)",
  "trap 'x=1 > nodir/f' EXIT",
  "x=1 > nodir/f &",
];

describe("failing output redirections never reject exec()", () => {
  describe.each(TARGETS)("$name", (target) => {
    it.each(CONTEXTS)("in a $name", async (context) => {
      const problems: string[] = [];
      for (const form of FORMS) {
        problems.push(...(await checkCase(context, form, target)));
      }
      expect(problems).toEqual([]);
    });
  });
});

describe("other redirection syntax around a failing target", () => {
  it.each(OTHER_SCRIPTS)("resolves: %s", async (script) => {
    const env = new Bash();
    try {
      const result = await env.exec(script);
      expect(typeof result.exitCode).toBe("number");
    } finally {
      env.destroy();
    }
  });
});
