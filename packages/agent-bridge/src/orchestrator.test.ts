import type { Bash } from "@ag-bash/bash";
import { describe, expect, it, vi } from "vitest";
import { type AgentAdapter, type TerminalWriter, UIMessage } from "./index.js";
import { AgentOrchestrator } from "./orchestrator.js";

describe("AgentOrchestrator", () => {
  const mockWriter: TerminalWriter = {
    write: vi.fn(),
  };

  it("should initialize and handle messages via adapter", async () => {
    const mockAdapter: AgentAdapter = {
      type: "test",
      async *run(messages) {
        yield { type: "text-delta", delta: "Hello" };
        yield { type: "text-end" };
      },
    };

    const mockBash = {
      execute: vi.fn(),
      snapshot: vi.fn(),
      restore: vi.fn(),
    } as unknown as Bash;

    const orchestrator = new AgentOrchestrator({
      bash: mockBash,
      adapter: mockAdapter,
      writer: mockWriter,
    });

    await orchestrator.run("hello");

    const messages = orchestrator.getMessages();
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("should process bash commands from adapter", async () => {
    const mockAdapter: AgentAdapter = {
      type: "test",
      async *run(messages) {
        yield { type: "text-delta", delta: "I will run ls" };
        yield {
          type: "tool-input-available",
          toolCallId: "call1",
          toolName: "bash",
          input: { command: "ls" },
        };
        yield {
          type: "tool-output-available",
          toolCallId: "call1",
          output: JSON.stringify({
            stdout: "file1.txt",
            stderr: "",
            exitCode: 0,
          }),
        };
        yield { type: "text-end" };
      },
    };

    const mockBash = {
      execute: vi.fn().mockResolvedValue({ output: "file1.txt", exitCode: 0 }),
      snapshot: vi.fn().mockReturnValue({ fs: {} }),
      restore: vi.fn(),
    } as unknown as Bash;

    const orchestrator = new AgentOrchestrator({
      bash: mockBash,
      adapter: mockAdapter,
      writer: mockWriter,
    });

    await orchestrator.run("run ls");

    expect(mockWriter.write).toHaveBeenCalledWith(
      expect.stringContaining("file1.txt"),
    );
  });
});
