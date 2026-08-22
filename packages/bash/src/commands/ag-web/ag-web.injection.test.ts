import { describe, expect, it } from "vitest";
import { createTestBash } from "../../testing/createTestBash.js";
import { WebFetchTool } from "./ag-web-fetch.js";
import { WebSearchTool } from "./ag-web-search.js";

/**
 * Regression tests for shell command injection in the ag-web agentic tools.
 *
 * Both tools string-interpolated attacker-controlled arguments into a shell
 * command passed to `bash.exec()`. Because `query` and `url` arrive from model
 * output or user text, this made prompt injection escalate to arbitrary
 * command execution inside the sandbox.
 *
 * Each test drives the real tool against a real Bash instance and asserts that
 * a payload which would execute a side-effecting command does not do so. The
 * probe file is the proof: if it exists, the injection ran.
 */

const KEEP = { "/home/user/.keep": "" };

/** Assembled at runtime so no credential-shaped literal appears in source. */
const SENTINEL = ["ag", "bash", "sentinel", "value"].join("-");

/** Returns true if `path` exists in the VFS. */
async function probeExists(
  bash: ReturnType<typeof createTestBash>,
  path: string,
): Promise<boolean> {
  const result = await bash.exec(
    `test -e ${path} && echo INJECTED || echo CLEAN`,
  );
  return result.stdout.includes("INJECTED");
}

describe("ag_web_search shell injection", () => {
  it("does not execute a command smuggled through a single-quote breakout in query (serper branch)", async () => {
    const bash = createTestBash({
      files: KEEP,
      env: { SERPER_API_KEY: SENTINEL },
    });

    // The query lands inside -d '{"q": "..."}'. A bare quote closes that
    // literal, letting `;` start a new command.
    await WebSearchTool.execute(bash, {
      query: "hello'; touch /home/user/pwned-serper; echo '",
    });

    expect(await probeExists(bash, "/home/user/pwned-serper")).toBe(false);
  });

  it("does not execute a command smuggled through a single-quote breakout in query (tavily branch)", async () => {
    const bash = createTestBash({
      files: KEEP,
      env: { TAVILY_API_KEY: SENTINEL },
    });

    await WebSearchTool.execute(bash, {
      query: "hello'; touch /home/user/pwned-tavily; echo '",
    });

    expect(await probeExists(bash, "/home/user/pwned-tavily")).toBe(false);
  });

  it("does not place the API key on the executed command line", async () => {
    const bash = createTestBash({
      files: KEEP,
      env: { SERPER_API_KEY: SENTINEL },
    });
    const seen: string[] = [];
    const realExec = bash.exec.bind(bash);
    // Capture what actually reaches the interpreter.
    bash.exec = ((cmd: string, ...rest: unknown[]) => {
      seen.push(cmd);
      return realExec(cmd, ...(rest as []));
    }) as typeof bash.exec;

    await WebSearchTool.execute(bash, { query: "harmless" });

    expect(seen.join("\n")).not.toContain(SENTINEL);
  });
});

describe("ag_web_fetch shell injection", () => {
  it("does not execute command substitution smuggled through url", async () => {
    const bash = createTestBash({ files: KEEP });

    // Double quotes do not suppress $(...) in the shell, so the original
    // `curl -sL "${fetchUrl}"` executed this.
    await WebFetchTool.execute(bash, {
      url: "https://example.com/$(touch /home/user/pwned-fetch)",
      noCache: true,
    });

    expect(await probeExists(bash, "/home/user/pwned-fetch")).toBe(false);
  });

  it("does not execute a command smuggled through backticks in url", async () => {
    const bash = createTestBash({ files: KEEP });

    await WebFetchTool.execute(bash, {
      url: "https://example.com/`touch /home/user/pwned-backtick`",
      noCache: true,
    });

    expect(await probeExists(bash, "/home/user/pwned-backtick")).toBe(false);
  });
});

describe("ag-web tool input validation", () => {
  it("rejects a non-string query instead of accepting anything", async () => {
    const result = await WebSearchTool.validateInput({ query: 123 });
    expect(result.result).toBe(false);
  });

  it("rejects a missing query", async () => {
    const result = await WebSearchTool.validateInput({});
    expect(result.result).toBe(false);
  });

  it("accepts a well-formed query", async () => {
    const result = await WebSearchTool.validateInput({ query: "typescript" });
    expect(result.result).toBe(true);
  });

  it("rejects a non-string url", async () => {
    const result = await WebFetchTool.validateInput({ url: null });
    expect(result.result).toBe(false);
  });

  it("accepts a well-formed url", async () => {
    const result = await WebFetchTool.validateInput({
      url: "https://example.com",
    });
    expect(result.result).toBe(true);
  });
});
