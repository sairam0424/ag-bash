import { beforeEach, describe, expect, it, vi } from "vitest";
import { Bash } from "./Bash.js";
import { InMemoryFs } from "./fs/in-memory-fs/index.js";
import { AgentManager } from "./services/AgentManager.js";
import { McpClient } from "./services/McpClient.js";

const mockClient = {
  connectStdio: vi.fn(),
  connectHttp: vi.fn(),
  listConnections: vi.fn().mockReturnValue([]),
  disconnect: vi.fn(),
  callTool: vi.fn(),
};

vi.mock("./services/McpClient.js", () => {
  return {
    // Must be newable: ServiceContainer does `new McpClient()`. A plain
    // `vi.fn(() => mockClient)` is callable but assigning the instance's
    // members keeps it a valid constructor and exposes the mocked methods.
    McpClient: vi.fn(function (this: Record<string, unknown>) {
      Object.assign(this, mockClient);
    }),
  };
});

describe("Nexus Prime Integration (MCP & Orchestration)", () => {
  let bash: Bash;
  let fs: InMemoryFs;

  beforeEach(() => {
    fs = new InMemoryFs();
    bash = new Bash({ fs, agentic: { enabled: true } });
    // Reset singletons if necessary
    // @ts-expect-error
    AgentManager.instance = undefined;
    // @ts-expect-error
    McpClient.instance = undefined;
  });

  describe("Pillar 4: Orchestration (Sub-agents)", () => {
    it("should spawn a sub-agent and wait for completion", async () => {
      // Use a command that actually produces stdout without redirection to test wait output
      const result = await bash.exec('ag-spawn sub1 "echo hello"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Spawned sub-agent sub1");

      const waitResult = await bash.exec("ag-wait sub1");
      expect(waitResult.exitCode).toBe(0);
      expect(waitResult.stdout).toContain("hello");
    });

    it("should list active agents", async () => {
      await bash.exec('ag-spawn agentA "sleep 1"');
      await bash.exec('ag-spawn agentB "sleep 1"');

      const listResult = await bash.exec("ag-list-agents");
      expect(listResult.stdout).toContain("agentA: running");
      expect(listResult.stdout).toContain("agentB: running");
    });

    it("should handle invalid sub-agent ID", async () => {
      const result = await bash.exec("ag-wait non_existent");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Wait failed: Agent non_existent not found",
      );
    });

    it("should handle duplicate sub-agent ID", async () => {
      await bash.exec('ag-spawn dup "echo 1"');
      const result = await bash.exec('ag-spawn dup "echo 2"');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Spawn failed: Agent with ID dup already exists",
      );
    });
  });

  describe("Pillar 3: MCP Integration", () => {
    it("should register MCP tools in the toolbox after connection", async () => {
      const mockConn = {
        id: "test-server",
        name: "test-server",
        type: "stdio" as const,
        status: "connected" as const,
        tools: [
          { name: "mcp_test_tool", description: "test", inputSchema: {} },
        ],
      };
      mockClient.connectStdio.mockResolvedValueOnce(mockConn);
      mockClient.listConnections.mockReturnValue([mockConn]);

      const result = await bash.exec(
        "ag-mcp connect stdio test-server node server.js",
      );
      expect(result.exitCode).toBe(0);

      // Verify connection and tools via ag-mcp list
      const listResult = await bash.exec("ag-mcp list");
      expect(listResult.stdout).toContain("test-server");
      expect(listResult.stdout).toContain("mcp_test_tool");

      // Check if tool is registered in toolbox
      const tools = bash.toolbox.getTools();
      const hasTool = tools.some(
        (t) => t.name === "mcp_test-server_mcp_test_tool",
      );
      expect(hasTool).toBe(true);
    });

    it("should handle connection errors gracefully", async () => {
      // Re-mock for this specific test
      const client = bash.services.mcpClient;
      vi.mocked(client.connectStdio).mockRejectedValueOnce(
        new Error("Connection failed"),
      );

      const result = await bash.exec(
        "ag-mcp connect stdio fail-server node server.js",
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Connection failed: Connection failed");
    });
  });

  describe("Pillar 2: Intelligent Workflows", () => {
    it("should find symbols across the workspace", async () => {
      // Use bash syntax for test to avoid tree-sitter initialization complexity
      await bash.fs.writeFile(
        "/test.sh",
        "function my_test_bash_func() {\n  echo 1\n}",
      );
      await bash.exec("ag-analyze /test.sh");

      const result = await bash.exec("ag-find-symbol my_test_bash_func");
      expect(result.stdout).toContain("my_test_bash_func");
      expect(result.stdout).toContain("/test.sh");
    });
  });
});
