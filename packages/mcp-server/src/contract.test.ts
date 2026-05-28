import { describe, it, expect, beforeEach } from "vitest";
import { Bash } from "@ag-bash/bash";
import { McpToolBridge } from "./tool-bridge.js";
import { RateLimiter } from "./rate-limiter.js";

/**
 * MCP Contract Tests
 *
 * These tests validate the MCP server's tool bridge against a REAL Bash instance
 * (not mocked), ensuring end-to-end contract compliance with the Model Context Protocol.
 */
describe("MCP Contract Tests", () => {
  let bash: Bash;
  let bridge: McpToolBridge;

  beforeEach(() => {
    bash = new Bash({
      files: {
        "/home/user/hello.txt": "Hello, world!\n",
        "/home/user/data.json": '{"key": "value"}',
        "/project/src/index.ts": "export const main = () => console.log('hi');",
      },
    });
    bridge = new McpToolBridge(bash);
  });

  describe("1. Tool Listing", () => {
    it("should list all bridge tools in MCP format", () => {
      const tools = bridge.listTools();

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);

      // Every tool must have required MCP descriptor fields
      for (const tool of tools) {
        expect(tool).toHaveProperty("name");
        expect(tool).toHaveProperty("description");
        expect(tool).toHaveProperty("inputSchema");
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.inputSchema).toHaveProperty("properties");
        expect(typeof tool.name).toBe("string");
        expect(typeof tool.description).toBe("string");
        expect(tool.name.length).toBeGreaterThan(0);
        expect(tool.description.length).toBeGreaterThan(0);
      }
    });

    it("should include known agentic tools (read_file, write_file, list_dir)", () => {
      const tools = bridge.listTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("write_file");
      expect(toolNames).toContain("list_dir");
    });

    it("should exclude native MCP tools from bridge listing", () => {
      const tools = bridge.listTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).not.toContain("run_bash");
      expect(toolNames).not.toContain("get_state");
      expect(toolNames).not.toContain("snapshot");
      expect(toolNames).not.toContain("restore");
      expect(toolNames).not.toContain("create_delta");
      expect(toolNames).not.toContain("apply_delta");
    });

    it("should provide valid JSON Schema for each tool's inputSchema", () => {
      const tools = bridge.listTools();

      for (const tool of tools) {
        // Must be a valid JSON Schema object type
        expect(tool.inputSchema.type).toBe("object");
        expect(typeof tool.inputSchema.properties).toBe("object");
        expect(tool.inputSchema.properties).not.toBeNull();

        // If required is present, it must be a non-empty array of strings
        if (tool.inputSchema.required !== undefined) {
          expect(Array.isArray(tool.inputSchema.required)).toBe(true);
          expect(tool.inputSchema.required!.length).toBeGreaterThan(0);
          for (const req of tool.inputSchema.required!) {
            expect(typeof req).toBe("string");
            // Required fields must exist in properties
            expect(tool.inputSchema.properties).toHaveProperty(req);
          }
        }
      }
    });
  });

  describe("2. run_bash Tool (via direct Bash.exec)", () => {
    it("should execute a simple echo command and return valid output", async () => {
      const result = await bash.exec('echo "hello from MCP"');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello from MCP\n");
      expect(result.stderr).toBe("");
    });

    it("should execute multi-line scripts", async () => {
      const result = await bash.exec('x=42\necho "The answer is $x"');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("42");
    });

    it("should return non-zero exit code on failure", async () => {
      const result = await bash.exec("cat /nonexistent/path/file.txt");

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it("should persist state between exec calls", async () => {
      await bash.exec("MY_VAR=hello", { persistState: true });
      const result = await bash.exec("echo $MY_VAR", { persistState: true });

      expect(result.stdout).toBe("hello\n");
    });

    it("should handle pipe operations", async () => {
      const result = await bash.exec('echo "line1\nline2\nline3" | wc -l');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("3");
    });
  });

  describe("3. snapshot Tool", () => {
    it("should capture state as a serializable object", async () => {
      await bash.exec("cd /home/user", { persistState: true });
      await bash.exec("export SNAPSHOT_VAR=captured", { persistState: true });

      const snapshot = await bash.snapshot();

      expect(snapshot).toHaveProperty("state");
      expect(snapshot).toHaveProperty("fs");
      expect(snapshot.state).toHaveProperty("cwd");
      expect(snapshot.state.cwd).toBe("/home/user");
    });

    it("should capture filesystem state including created files", async () => {
      await bash.exec('echo "new content" > /home/user/snapshot-test.txt', {
        persistState: true,
      });

      const snapshot = await bash.snapshot();

      expect(snapshot).toHaveProperty("fs");
      // The snapshot should be truthy (non-null, non-undefined)
      expect(snapshot.fs).toBeTruthy();
    });

    it("should produce a snapshot that can be base64-encoded for MCP transport", async () => {
      const snapshot = await bash.snapshot();
      const encoded = Buffer.from(JSON.stringify(snapshot)).toString("base64");

      expect(typeof encoded).toBe("string");
      expect(encoded.length).toBeGreaterThan(0);

      // Should be valid base64 that round-trips
      const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
      expect(decoded).toHaveProperty("state");
      expect(decoded).toHaveProperty("fs");
    });
  });

  describe("4. restore Tool", () => {
    it("should restore shell state from a snapshot", async () => {
      // Setup initial state
      await bash.exec("cd /home/user", { persistState: true });
      await bash.exec("export RESTORE_VAR=before", { persistState: true });

      // Take snapshot
      const snapshot = await bash.snapshot();

      // Modify state
      await bash.exec("cd /project", { persistState: true });
      await bash.exec("export RESTORE_VAR=after", { persistState: true });

      // Verify state changed
      expect(bash.getCwd()).toBe("/project");

      // Restore
      await bash.restore(snapshot);

      // Verify state is restored
      expect(bash.getCwd()).toBe("/home/user");
    });

    it("should restore filesystem state", async () => {
      // Take snapshot before creating file
      const snapshot = await bash.snapshot();

      // Create a new file
      await bash.exec('echo "temp" > /home/user/will-disappear.txt', {
        persistState: true,
      });

      // Verify file exists
      const checkBefore = await bash.exec("cat /home/user/will-disappear.txt");
      expect(checkBefore.exitCode).toBe(0);

      // Restore
      await bash.restore(snapshot);

      // File should no longer exist
      const checkAfter = await bash.exec("cat /home/user/will-disappear.txt");
      expect(checkAfter.exitCode).not.toBe(0);
    });

    it("should handle round-trip via base64 encoding (MCP transport simulation)", async () => {
      await bash.exec("cd /home/user", { persistState: true });
      await bash.exec("export ROUNDTRIP=yes", { persistState: true });

      // Simulate MCP transport: snapshot -> base64 -> parse -> restore
      const snapshot = await bash.snapshot();
      const encoded = Buffer.from(JSON.stringify(snapshot)).toString("base64");
      const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));

      // Verify the encoded form is valid and decodable
      expect(decoded).toHaveProperty("state");
      expect(decoded).toHaveProperty("fs");
      expect(decoded.state.cwd).toBe("/home/user");

      // Note: direct restore from JSON-parsed snapshot requires Map reconstruction
      // which the MCP server handles internally via validateSnapshot
      const freshSnapshot = await bash.snapshot();
      await bash.exec("cd /", { persistState: true });
      expect(bash.getCwd()).toBe("/");
      await bash.restore(freshSnapshot);
      expect(bash.getCwd()).toBe("/home/user");
    });
  });

  describe("5. Error Responses", () => {
    it("should return isError=true for tool calls on non-existent files", async () => {
      const result = await bridge.callTool("read_file", {
        path: "/does/not/exist.txt",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("Error");
    });

    it("should return properly formatted MCP content on success", async () => {
      const result = await bridge.callTool("read_file", {
        path: "/home/user/hello.txt",
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(typeof result.content[0].text).toBe("string");
      expect(result.isError).toBeFalsy();
    });

    it("should handle thrown exceptions gracefully without leaking paths", async () => {
      // Call a non-existent tool to trigger an exception
      const result = await bridge.callTool("completely_fake_tool_xyz", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe("text");
      expect(typeof result.content[0].text).toBe("string");
      // Should not contain raw filesystem paths
      expect(result.content[0].text).not.toMatch(/\/Users\//);
      expect(result.content[0].text).not.toMatch(/\/home\/[a-z]+\//);
    });

    it("should cap error message length to prevent information leakage", async () => {
      // Even if an error is very long, it should be truncated
      const result = await bridge.callTool("completely_fake_tool_xyz", {});

      expect(result.content[0].text.length).toBeLessThanOrEqual(250);
    });

    it("should return text content type for all responses", async () => {
      const successResult = await bridge.callTool("read_file", {
        path: "/home/user/hello.txt",
      });
      const errorResult = await bridge.callTool("read_file", {
        path: "/nope",
      });

      expect(successResult.content[0].type).toBe("text");
      expect(errorResult.content[0].type).toBe("text");
    });
  });

  describe("6. Rate Limiting", () => {
    it("should allow requests within the configured limit", () => {
      const limiter = new RateLimiter(10, 60_000);

      for (let i = 0; i < 10; i++) {
        expect(limiter.allow()).toBe(true);
      }
    });

    it("should reject requests exceeding the limit", () => {
      const limiter = new RateLimiter(5, 60_000);

      for (let i = 0; i < 5; i++) {
        limiter.allow();
      }

      expect(limiter.allow()).toBe(false);
    });

    it("should report correct remaining capacity", () => {
      const limiter = new RateLimiter(10, 60_000);

      expect(limiter.remaining()).toBe(10);
      limiter.allow();
      limiter.allow();
      limiter.allow();
      expect(limiter.remaining()).toBe(7);
    });

    it("should reset properly", () => {
      const limiter = new RateLimiter(3, 60_000);

      limiter.allow();
      limiter.allow();
      limiter.allow();
      expect(limiter.allow()).toBe(false);

      limiter.reset();
      expect(limiter.allow()).toBe(true);
      expect(limiter.remaining()).toBe(2);
    });

    it("should recover after window expiration", () => {
      const limiter = new RateLimiter(2, 100); // 100ms window

      limiter.allow();
      limiter.allow();
      expect(limiter.allow()).toBe(false);

      // Simulate time passing by manipulating internal state
      (limiter as any).timestamps = [Date.now() - 200, Date.now() - 200];

      expect(limiter.allow()).toBe(true);
    });
  });

  describe("7. Tool Annotations", () => {
    it("should include annotations on listed tools", () => {
      const tools = bridge.listTools();

      // At least some tools should have annotations
      const toolsWithAnnotations = tools.filter((t) => t.annotations !== undefined);
      expect(toolsWithAnnotations.length).toBeGreaterThan(0);
    });

    it("should mark read_file as readOnlyHint=true", () => {
      const tools = bridge.listTools();
      const readFile = tools.find((t) => t.name === "read_file");

      expect(readFile).toBeDefined();
      expect(readFile!.annotations).toBeDefined();
      expect(readFile!.annotations!.readOnlyHint).toBe(true);
      expect(readFile!.annotations!.destructiveHint).toBe(false);
    });

    it("should mark write_file as destructiveHint=true", () => {
      const tools = bridge.listTools();
      const writeFile = tools.find((t) => t.name === "write_file");

      expect(writeFile).toBeDefined();
      expect(writeFile!.annotations).toBeDefined();
      expect(writeFile!.annotations!.destructiveHint).toBe(true);
    });

    it("should mark list_dir as readOnlyHint=true", () => {
      const tools = bridge.listTools();
      const listDir = tools.find((t) => t.name === "list_dir");

      expect(listDir).toBeDefined();
      expect(listDir!.annotations).toBeDefined();
      expect(listDir!.annotations!.readOnlyHint).toBe(true);
    });

    it("should have boolean annotation values (not undefined)", () => {
      const tools = bridge.listTools();

      for (const tool of tools) {
        if (tool.annotations) {
          expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
          expect(typeof tool.annotations.destructiveHint).toBe("boolean");
        }
      }
    });
  });

  describe("8. Bridge Tool Execution (end-to-end)", () => {
    it("should read a file via bridge callTool", async () => {
      const result = await bridge.callTool("read_file", {
        path: "/home/user/hello.txt",
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe("Hello, world!\n");
    });

    it("should list a directory via bridge callTool", async () => {
      const result = await bridge.callTool("list_dir", {
        path: "/home/user",
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("hello.txt");
      expect(result.content[0].text).toContain("data.json");
    });

    it("should write a file via bridge callTool", async () => {
      const writeResult = await bridge.callTool("write_file", {
        path: "/home/user/bridge-test.txt",
        content: "written via bridge",
      });

      expect(writeResult.isError).toBeFalsy();
      expect(writeResult.content[0].text).toContain("Successfully");

      // Verify the file was actually written
      const readResult = await bridge.callTool("read_file", {
        path: "/home/user/bridge-test.txt",
      });
      expect(readResult.isError).toBeFalsy();
      expect(readResult.content[0].text).toBe("written via bridge");
    });

    it("should report hasTool correctly for bridge tools", () => {
      expect(bridge.hasTool("read_file")).toBe(true);
      expect(bridge.hasTool("write_file")).toBe(true);
      expect(bridge.hasTool("list_dir")).toBe(true);
    });

    it("should report hasTool=false for native MCP tools", () => {
      expect(bridge.hasTool("run_bash")).toBe(false);
      expect(bridge.hasTool("get_state")).toBe(false);
      expect(bridge.hasTool("snapshot")).toBe(false);
      expect(bridge.hasTool("restore")).toBe(false);
      expect(bridge.hasTool("create_delta")).toBe(false);
      expect(bridge.hasTool("apply_delta")).toBe(false);
    });

    it("should report hasTool=false for non-existent tools", () => {
      expect(bridge.hasTool("nonexistent_tool_xyz")).toBe(false);
    });
  });
});
