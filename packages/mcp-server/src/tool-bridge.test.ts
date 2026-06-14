import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpToolBridge } from "./tool-bridge.js";
import { RateLimiter } from "./rate-limiter.js";

// --- Mock Setup ---

const mockToolbox = {
  getAgenticTools: vi.fn(),
  callTool: vi.fn(),
  getTool: vi.fn(),
  getTools: vi.fn(),
};

const mockBash = {
  toolbox: mockToolbox,
  exec: vi.fn(),
  getCwd: vi.fn(),
  getEnv: vi.fn(),
} as unknown as any;

// --- McpToolBridge Tests ---

describe("McpToolBridge", () => {
  let bridge: McpToolBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new McpToolBridge(mockBash);
  });

  describe("listTools", () => {
    it("returns tool descriptors in MCP format", () => {
      mockToolbox.getAgenticTools.mockReturnValue({
        read_file: {
          description: "Read the contents of a file from the virtual filesystem.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute path to the file to read." },
            },
            required: ["path"],
          },
        },
        write_file: {
          description: "Create or overwrite a file in the virtual filesystem.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute path to the file to write." },
              content: { type: "string", description: "The content to write to the file." },
            },
            required: ["path", "content"],
          },
        },
      });

      const tools = bridge.listTools();

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe("read_file");
      expect(tools[0].description).toBe(
        "Read the contents of a file from the virtual filesystem.",
      );
      expect(tools[0].inputSchema.type).toBe("object");
      expect(tools[0].inputSchema.properties).toHaveProperty("path");
      expect(tools[0].inputSchema.required).toContain("path");
    });

    it("excludes native MCP tools (run_bash, get_state, etc.)", () => {
      mockToolbox.getAgenticTools.mockReturnValue({
        run_bash: {
          description: "Should be excluded",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        get_state: {
          description: "Should be excluded",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        snapshot: {
          description: "Should be excluded",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        restore: {
          description: "Should be excluded",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        create_delta: {
          description: "Should be excluded",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        apply_delta: {
          description: "Should be excluded",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        read_file: {
          description: "Should be included",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      });

      const tools = bridge.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("read_file");
    });

    it("omits required field when no required params exist", () => {
      mockToolbox.getAgenticTools.mockReturnValue({
        check_environment: {
          description: "Get diagnostics about the sandboxed environment.",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      });

      const tools = bridge.listTools();

      expect(tools[0].inputSchema.required).toBeUndefined();
    });

    it("returns empty list when no tools registered", () => {
      mockToolbox.getAgenticTools.mockReturnValue({});

      const tools = bridge.listTools();

      expect(tools).toHaveLength(0);
    });
  });

  describe("callTool", () => {
    it("executes a tool and returns text content", async () => {
      mockToolbox.callTool.mockResolvedValue("file contents here");

      const result = await bridge.callTool("read_file", { path: "/test.txt" });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toBe("file contents here");
      expect(result.isError).toBeFalsy();
      expect(mockToolbox.callTool).toHaveBeenCalledWith(
        mockBash,
        "read_file",
        { path: "/test.txt" },
      );
    });

    it("serializes object results to JSON", async () => {
      mockToolbox.callTool.mockResolvedValue({ success: true, id: "123" });

      const result = await bridge.callTool("add_todo", { task: "test" });

      expect(result.content[0].text).toBe(
        JSON.stringify({ success: true, id: "123" }, null, 2),
      );
      expect(result.isError).toBeFalsy();
    });

    it("marks error results as isError", async () => {
      mockToolbox.callTool.mockResolvedValue(
        "Error reading file: ENOENT: no such file",
      );

      const result = await bridge.callTool("read_file", {
        path: "/nonexistent",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error reading file");
    });

    it("marks validation error results as isError", async () => {
      mockToolbox.callTool.mockResolvedValue(
        "Validation Error: Invalid input",
      );

      const result = await bridge.callTool("edit_file", {});

      expect(result.isError).toBe(true);
    });

    it("marks permission denied results as isError", async () => {
      mockToolbox.callTool.mockResolvedValue(
        "Permission Denied: Execution blocked",
      );

      const result = await bridge.callTool("write_file", {
        path: "/protected",
        content: "hack",
      });

      expect(result.isError).toBe(true);
    });

    it("handles thrown exceptions gracefully", async () => {
      mockToolbox.callTool.mockRejectedValue(new Error("Tool not found: xyz"));

      const result = await bridge.callTool("xyz", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: Tool not found: xyz");
    });

    it("handles non-Error thrown values", async () => {
      mockToolbox.callTool.mockRejectedValue("string error");

      const result = await bridge.callTool("broken_tool", {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: Unknown error occurred");
    });
  });

  describe("hasTool", () => {
    it("returns true for registered bridge tools", () => {
      mockToolbox.getTool.mockReturnValue({ name: "read_file" });

      expect(bridge.hasTool("read_file")).toBe(true);
    });

    it("returns false for native MCP tools", () => {
      expect(bridge.hasTool("run_bash")).toBe(false);
      expect(bridge.hasTool("get_state")).toBe(false);
      expect(bridge.hasTool("snapshot")).toBe(false);
      expect(bridge.hasTool("restore")).toBe(false);
      expect(bridge.hasTool("create_delta")).toBe(false);
      expect(bridge.hasTool("apply_delta")).toBe(false);
    });

    it("returns false for unregistered tools", () => {
      mockToolbox.getTool.mockReturnValue(undefined);

      expect(bridge.hasTool("nonexistent_tool")).toBe(false);
    });
  });
});

// --- RateLimiter Tests ---

describe("RateLimiter", () => {
  describe("allow", () => {
    it("allows requests within the limit", () => {
      const limiter = new RateLimiter(5, 60_000);

      expect(limiter.allow()).toBe(true);
      expect(limiter.allow()).toBe(true);
      expect(limiter.allow()).toBe(true);
      expect(limiter.allow()).toBe(true);
      expect(limiter.allow()).toBe(true);
    });

    it("rejects requests beyond the limit", () => {
      const limiter = new RateLimiter(3, 60_000);

      expect(limiter.allow()).toBe(true);
      expect(limiter.allow()).toBe(true);
      expect(limiter.allow()).toBe(true);
      // 4th request should be rejected
      expect(limiter.allow()).toBe(false);
      expect(limiter.allow()).toBe(false);
    });

    it("allows requests again after the window expires", () => {
      const limiter = new RateLimiter(2, 100); // 100ms window

      expect(limiter.allow()).toBe(true);
      expect(limiter.allow()).toBe(true);
      expect(limiter.allow()).toBe(false);

      // Simulate time passing by manipulating timestamps directly
      // We access private field for testing purposes
      (limiter as any).timestamps = [Date.now() - 200, Date.now() - 200];

      expect(limiter.allow()).toBe(true);
    });

    it("handles a single request limit", () => {
      const limiter = new RateLimiter(1, 60_000);

      expect(limiter.allow()).toBe(true);
      expect(limiter.allow()).toBe(false);
    });
  });

  describe("reset", () => {
    it("clears all tracked timestamps", () => {
      const limiter = new RateLimiter(2, 60_000);

      limiter.allow();
      limiter.allow();
      expect(limiter.allow()).toBe(false);

      limiter.reset();

      expect(limiter.allow()).toBe(true);
      expect(limiter.allow()).toBe(true);
    });
  });

  describe("remaining", () => {
    it("returns full capacity initially", () => {
      const limiter = new RateLimiter(10, 60_000);

      expect(limiter.remaining()).toBe(10);
    });

    it("decreases as requests are made", () => {
      const limiter = new RateLimiter(5, 60_000);

      limiter.allow();
      limiter.allow();

      expect(limiter.remaining()).toBe(3);
    });

    it("returns zero when limit is reached", () => {
      const limiter = new RateLimiter(2, 60_000);

      limiter.allow();
      limiter.allow();

      expect(limiter.remaining()).toBe(0);
    });
  });

  describe("constructor defaults", () => {
    it("defaults to 60 requests per 60 seconds", () => {
      const limiter = new RateLimiter();

      // Should allow 60 requests
      for (let i = 0; i < 60; i++) {
        expect(limiter.allow()).toBe(true);
      }
      // 61st should fail
      expect(limiter.allow()).toBe(false);
    });
  });
});
