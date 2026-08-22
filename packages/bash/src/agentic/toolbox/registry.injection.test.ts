import { describe, expect, it } from "vitest";
import { createTestBash } from "../../testing/createTestBash.js";
import { BashToolbox } from "./registry.js";

/**
 * Regression tests for shell command injection across the agentic tool surface.
 *
 * Six registered tools built their `bash.exec()` command by interpolating
 * attacker-controlled arguments into a shell string. Several did not quote the
 * argument at all; the two that used `JSON.stringify` were still exposed
 * because JSON escaping neutralises `"` but not `$`, so `$(...)` still expands
 * inside the resulting double-quoted word.
 *
 * Tool arguments originate in model output, so every one of these turns prompt
 * injection into arbitrary command execution inside the sandbox.
 *
 * Note: for `run_js` and `glob_files` the substitution fires while the shell
 * parses the command line, before the JS/glob runtime is invoked at all, so
 * these assertions hold whether or not those runtimes are available here.
 */

const KEEP = {
  "/home/user/.keep": "",
  "/home/user/a.txt": "alpha\n",
  "/home/user/b.txt": "beta\n",
};

async function probeExists(
  bash: ReturnType<typeof createTestBash>,
  path: string,
): Promise<boolean> {
  const result = await bash.exec(
    `test -e ${path} && echo INJECTED || echo CLEAN`,
  );
  return result.stdout.includes("INJECTED");
}

/** Runs a registered tool by name against a fresh test shell. */
async function runTool(
  bash: ReturnType<typeof createTestBash>,
  name: string,
  args: unknown,
): Promise<void> {
  const tool = new BashToolbox().getTool(name);
  expect(tool, `tool '${name}' should be registered`).toBeDefined();
  try {
    await tool?.execute(bash, args);
  } catch {
    // A tool failing is fine and expected once the payload is inert. The
    // assertion that matters is whether the injected command ran.
  }
}

describe("agentic toolbox shell injection", () => {
  it("grep_search does not execute a command smuggled through the unquoted path", async () => {
    const bash = createTestBash({ files: KEEP });

    await runTool(bash, "grep_search", {
      path: "/home/user; touch /home/user/pwned-grep",
      query: "alpha",
    });

    expect(await probeExists(bash, "/home/user/pwned-grep")).toBe(false);
  });

  it("grep_search does not execute command substitution smuggled through query", async () => {
    const bash = createTestBash({ files: KEEP });

    await runTool(bash, "grep_search", {
      path: "/home/user",
      query: "$(touch /home/user/pwned-grep-query)",
    });

    expect(await probeExists(bash, "/home/user/pwned-grep-query")).toBe(false);
  });

  it("diff_files does not execute a command smuggled through an unquoted file argument", async () => {
    const bash = createTestBash({ files: KEEP });

    await runTool(bash, "diff_files", {
      file1: "/home/user/a.txt",
      file2: "/home/user/b.txt; touch /home/user/pwned-diff",
    });

    expect(await probeExists(bash, "/home/user/pwned-diff")).toBe(false);
  });

  it("help_builtin does not execute a command smuggled through the command name", async () => {
    const bash = createTestBash({ files: KEEP });

    await runTool(bash, "help_builtin", {
      command: "echo; touch /home/user/pwned-help",
    });

    expect(await probeExists(bash, "/home/user/pwned-help")).toBe(false);
  });

  it("find_files does not execute a command smuggled through the unquoted path", async () => {
    const bash = createTestBash({ files: KEEP });

    // The trailing `#` comments out the ` -name "..."` tail the template
    // appends, so the smuggled `touch` receives no stray arguments.
    await runTool(bash, "find_files", {
      path: "/home/user; touch /home/user/pwned-find #",
      pattern: "*.txt",
    });

    expect(await probeExists(bash, "/home/user/pwned-find")).toBe(false);
  });

  it("run_js does not execute command substitution that JSON escaping leaves intact", async () => {
    const bash = createTestBash({ files: KEEP });

    // JSON.stringify escapes `"` but not `$`, so the shell still expands this
    // inside the double-quoted word it produces.
    await runTool(bash, "run_js", {
      code: "$(touch /home/user/pwned-js)",
    });

    expect(await probeExists(bash, "/home/user/pwned-js")).toBe(false);
  });

  it("glob_files does not execute command substitution smuggled through pattern", async () => {
    const bash = createTestBash({ files: KEEP });

    await runTool(bash, "glob_files", {
      pattern: "$(touch /home/user/pwned-glob)",
    });

    expect(await probeExists(bash, "/home/user/pwned-glob")).toBe(false);
  });

  // The five sites below were MISSED by the first pass. Its search was a
  // single-line regex for `.exec(` followed by an interpolated template
  // literal, but these calls put `.exec(` on one line and the literal on the
  // next -- and query_json builds into a `let cmd` first, then execs the
  // variable, so no call-site pattern matches it at all. Provenance of the
  // argument is the only sound check.

  it("query_json does not execute a command smuggled through query in the piped form", async () => {
    const bash = createTestBash({ files: KEEP });

    // `json` is escaped here but `query` never was, inside jq '...'.
    await runTool(bash, "query_json", {
      query: "'; touch /home/user/pwned-jq-query; echo '",
      json: '{"a":1}',
    });

    expect(await probeExists(bash, "/home/user/pwned-jq-query")).toBe(false);
  });

  it("query_json does not execute a command smuggled through the bare path argument", async () => {
    const bash = createTestBash({
      files: { ...KEEP, "/home/user/d.json": '{"a":1}\n' },
    });

    await runTool(bash, "query_json", {
      query: ".a",
      path: "/home/user/d.json; touch /home/user/pwned-jq-path",
    });

    expect(await probeExists(bash, "/home/user/pwned-jq-path")).toBe(false);
  });

  it("run_js_session does not execute a command smuggled through the bare sessionId", async () => {
    const bash = createTestBash({ files: KEEP });

    // Trailing `#` comments out the ` -c "..."` tail so the smuggled `touch`
    // receives no stray arguments.
    await runTool(bash, "run_js_session", {
      code: "1+1",
      sessionId: "main; touch /home/user/pwned-jssess #",
    });

    expect(await probeExists(bash, "/home/user/pwned-jssess")).toBe(false);
  });

  it("run_python does not execute command substitution that quote-escaping leaves intact", async () => {
    const bash = createTestBash({ files: KEEP });

    // .replace(/"/g, '\\"') escapes double quotes but not `$`.
    await runTool(bash, "run_python", {
      code: "$(touch /home/user/pwned-py)",
    });

    expect(await probeExists(bash, "/home/user/pwned-py")).toBe(false);
  });

  it("run_python_session does not execute a command smuggled through the bare sessionId", async () => {
    const bash = createTestBash({ files: KEEP });

    await runTool(bash, "run_python_session", {
      code: "pass",
      sessionId: "s1; touch /home/user/pwned-pysess #",
    });

    expect(await probeExists(bash, "/home/user/pwned-pysess")).toBe(false);
  });

  it("glob_files does not execute a command smuggled through the path option", async () => {
    const bash = createTestBash({ files: KEEP });

    await runTool(bash, "glob_files", {
      pattern: "*.txt",
      path: "$(touch /home/user/pwned-glob-path)",
    });

    expect(await probeExists(bash, "/home/user/pwned-glob-path")).toBe(false);
  });
});
