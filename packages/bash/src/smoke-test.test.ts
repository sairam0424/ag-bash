import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";
import { InMemoryFs } from "./fs/in-memory-fs/index.js";

describe("Ag-Bash v2.0 Smoke Test", () => {
  let bash: Bash;
  let fs: InMemoryFs;

  beforeEach(() => {
    fs = new InMemoryFs();
    bash = new Bash({
      fs,
      agentic: { enabled: true },
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          url: "http://example.com",
          headers: {},
          text: async () => "ok",
          json: async () => ({}),
          arrayBuffer: async () => new ArrayBuffer(0),
          blob: async () => new Blob(),
        }) as any,
      executionLimits: {
        maxNetworkTrafficBytes: 100,
        maxAgentNesting: 1,
        maxSubAgents: 2,
      },
    });
  });

  it("Feature: Semantic Analysis & Symbol Discovery", async () => {
    await bash.fs.writeFile(
      "/test.sh",
      'function smoke_test_func() {\n  echo "hello"\n}\nMY_VAR=123',
    );

    // Analyze and index
    const analyzeResult = await bash.exec("ag-analyze /test.sh");
    // Ensure indexer is populated
    await bash.indexer.indexFile("/test.sh");

    expect(analyzeResult.stdout).toContain("Functions (1)");
    expect(analyzeResult.stdout).toContain("smoke_test_func");

    // Find symbol
    const findResult = await bash.exec("ag-find-symbol smoke_test_func");
    expect(findResult.stdout).toContain("smoke_test_func");
  });

  it("Feature: Command Explanation", async () => {
    // Wrap in quotes to ensure it's a single argument if needed,
    // but ag-explain joins all positionals anyway.
    const result = await bash.exec(
      'ag-explain ls -l "|" grep txt ">" output.log',
    );
    expect(result.stdout).toContain("Execute command");
    expect(result.stdout).toContain("ls");
  });

  it("Feature: Project Todo Management", async () => {
    // Add todo
    await bash.exec('ag-todo add "Fix all the bugs"');

    // List todos
    const listResult = await bash.exec("ag-todo list");
    expect(listResult.stdout).toContain("[ ] Fix all the bugs");

    // Update todo
    await bash.exec("ag-todo update 1 doing");
    const updateResult = await bash.exec("ag-todo list");
    expect(updateResult.stdout).toContain("[/] Fix all the bugs");
  });

  it("Enforcement: Network Limits", async () => {
    // Manually push traffic over the limit
    // @ts-expect-error
    bash.state.networkTrafficBytes = 150;

    // Any subsequent command should now fail in executeStatement check
    const result = await bash.exec('echo "this should fail"');

    expect(result.exitCode).toBe(126); // Execution limit error
    expect(result.stderr).toContain("network traffic limit exceeded");
  });

  it("Enforcement: Orchestration Nesting", async () => {
    // Nesting limit is 1
    // Level 0 -> Spawn Level 1 (OK)
    await bash.exec('ag-spawn sub1 "echo level1"');

    // Level 1 -> Spawn Level 2 (FAIL)
    // We simulate this by trying to spawn from within the agent manager with a depth of 1
    const subAgent = new Bash({
      agentic: { enabled: true, nestingDepth: 1 },
      executionLimits: { maxAgentNesting: 1 },
    });

    const result = await subAgent.exec('ag-spawn sub2 "echo level2"');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Maximum agent nesting depth reached (1)");
  });
});
