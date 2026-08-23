import { Bash } from "@ag-bash/bash";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpToolAnnotations } from "./tool-bridge.js";
import { McpToolBridge } from "./tool-bridge.js";

/**
 * Annotation-resolution contract for McpToolBridge.listTools().
 *
 * The two MCP hints fail in OPPOSITE directions, so they get opposite defaults:
 *
 *   - `destructiveHint: false` tells a client "no confirmation needed". When the
 *     declaration cannot be resolved we must say `true` (assume destructive).
 *   - `readOnlyHint: false` tells a client "this may write". That is already the
 *     conservative answer, so unresolvable stays `false`.
 *
 * A function-valued declaration is argument-dependent and `listTools()` has no
 * arguments, so it is treated as UNRESOLVABLE rather than probed with synthetic
 * empty args.
 */

const mockToolbox = {
  getAgenticTools: vi.fn(),
  getTool: vi.fn(),
  callTool: vi.fn(),
};

const mockBash = { toolbox: mockToolbox } as unknown as Bash;

const STUB_INPUT_SCHEMA = {
  type: "object" as const,
  properties: Object.create(null) as Record<string, unknown>,
  required: [] as string[],
};

/**
 * Run listTools() over a single bridged tool named `probe` whose raw metadata is
 * `rawTool`, and return the annotations the bridge produced for it.
 */
function annotationsFor(rawTool: unknown): McpToolAnnotations | undefined {
  mockToolbox.getAgenticTools.mockReturnValue({
    probe: { description: "probe tool", inputSchema: STUB_INPUT_SCHEMA },
  });
  mockToolbox.getTool.mockReturnValue(rawTool);

  const tools = new McpToolBridge(mockBash).listTools();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("probe");
  return tools[0].annotations;
}

describe("McpToolBridge annotation resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("boolean declarations pass through verbatim", () => {
    it("resolves isReadOnly:true / isDestructive:false", () => {
      expect(
        annotationsFor({ isReadOnly: true, isDestructive: false }),
      ).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
      });
    });

    it("resolves isReadOnly:false / isDestructive:true", () => {
      expect(
        annotationsFor({ isReadOnly: false, isDestructive: true }),
      ).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });
  });

  describe("absent declarations take the conservative default", () => {
    it("defaults an undefined isDestructive to true and isReadOnly to false", () => {
      expect(
        annotationsFor({ isReadOnly: undefined, isDestructive: undefined }),
      ).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });

    it("defaults both hints when the raw tool has no hint keys at all", () => {
      expect(annotationsFor({ name: "probe" })).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });

    it("defaults to destructive when the raw tool is missing entirely", () => {
      expect(annotationsFor(undefined)).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });
  });

  describe("function-valued declarations are unresolvable at list time", () => {
    it("reports destructive for a function hint that returns true", () => {
      expect(
        annotationsFor({ isReadOnly: false, isDestructive: () => true }),
      ).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });

    it("reports destructive for a function hint that returns false", () => {
      expect(
        annotationsFor({ isReadOnly: false, isDestructive: () => false }),
      ).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });

    it("reports destructive for a function hint that returns undefined", () => {
      expect(
        annotationsFor({
          isReadOnly: false,
          isDestructive: () => undefined as unknown as boolean,
        }),
      ).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });

    it("reports destructive for a function hint that THROWS on empty args", () => {
      // This is the shape every argument-dependent hint in the engine has:
      // `(args) => args.command.trim()...` throws on `{}`.
      expect(
        annotationsFor({
          isReadOnly: false,
          isDestructive: (args: { command: string }) =>
            args.command.startsWith("rm"),
        }),
      ).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });

    it("never resolves a function-valued isReadOnly to true", () => {
      // `(args) => !args.write` returns true on empty args, which would
      // advertise a writing tool as read-only. Unresolvable must stay false.
      expect(
        annotationsFor({
          isReadOnly: (args: { write?: boolean }) => !args.write,
          isDestructive: true,
        }),
      ).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });

    it("does not invoke function-valued hints during listTools()", () => {
      const isReadOnly = vi.fn(() => true);
      const isDestructive = vi.fn(() => false);

      annotationsFor({ isReadOnly, isDestructive });

      expect(isReadOnly).not.toHaveBeenCalled();
      expect(isDestructive).not.toHaveBeenCalled();
    });
  });
});

describe("McpToolBridge annotations against the real BashToolbox", () => {
  it("does not surface destructiveHint:false for run_command", () => {
    const bash = new Bash();
    const tools = new McpToolBridge(bash).listTools();

    const runCommand = tools.find((t) => t.name === "run_command");
    expect(runCommand).toBeDefined();
    // run_command executes arbitrary bash: `rm -rf /` is one argument away.
    expect(runCommand?.annotations?.destructiveHint).toBe(true);
    expect(runCommand?.annotations?.readOnlyHint).toBe(false);
  });

  it("marks every tool with an argument-dependent isDestructive as destructive", () => {
    const bash = new Bash();
    const tools = new McpToolBridge(bash).listTools();

    const argDependent = tools.filter(
      (t) => typeof bash.toolbox.getTool(t.name)?.isDestructive === "function",
    );
    expect(argDependent.length).toBeGreaterThan(0);
    for (const tool of argDependent) {
      expect(tool.annotations?.destructiveHint).toBe(true);
    }
  });

  it("keeps statically read-only tools honest (read_file stays non-destructive)", () => {
    const bash = new Bash();
    const tools = new McpToolBridge(bash).listTools();

    const readFile = tools.find((t) => t.name === "read_file");
    expect(readFile?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });
});
