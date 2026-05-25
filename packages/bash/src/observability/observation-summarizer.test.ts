import { describe, it, expect, beforeEach } from "vitest";
import { ObservationSummarizer } from "./ObservationSummarizer.js";
import type { Observation } from "../types.js";

describe("ObservationSummarizer", () => {
  let summarizer: ObservationSummarizer;

  beforeEach(() => {
    summarizer = new ObservationSummarizer();
  });

  describe("startTurn / endTurn", () => {
    it("should produce a correct TurnSummary structure", () => {
      const turnId = summarizer.startTurn();
      expect(turnId).toBe("turn-1");

      const summary = summarizer.endTurn(turnId);

      expect(summary.turnId).toBe("turn-1");
      expect(summary.timestamp).toBeGreaterThan(0);
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);
      expect(summary.toolCalls).toEqual([]);
      expect(summary.observations).toEqual([]);
      expect(summary.filesModified).toEqual([]);
      expect(summary.filesRead).toEqual([]);
      expect(summary.exitCodes).toEqual([]);
      expect(summary.digest).toBe("No activity");
      expect(summary.estimatedTokens).toBeGreaterThan(0);
    });

    it("should increment turn IDs sequentially", () => {
      const id1 = summarizer.startTurn();
      summarizer.endTurn(id1);

      const id2 = summarizer.startTurn();
      summarizer.endTurn(id2);

      const id3 = summarizer.startTurn();
      summarizer.endTurn(id3);

      expect(id1).toBe("turn-1");
      expect(id2).toBe("turn-2");
      expect(id3).toBe("turn-3");
    });

    it("should throw when endTurn is called with wrong turnId", () => {
      summarizer.startTurn();

      expect(() => summarizer.endTurn("turn-999")).toThrow(
        "No active turn with id turn-999",
      );
    });

    it("should throw when endTurn is called with no active turn", () => {
      expect(() => summarizer.endTurn("turn-1")).toThrow(
        "No active turn with id turn-1",
      );
    });
  });

  describe("recordToolStart + recordToolEnd", () => {
    it("should create a ToolCallSummary on success", () => {
      const turnId = summarizer.startTurn();

      summarizer.recordToolStart("call-1", "bash", { cmd: "echo hello" });
      summarizer.recordToolEnd("call-1", "hello\n", 0);

      const summary = summarizer.endTurn(turnId);

      expect(summary.toolCalls).toHaveLength(1);
      expect(summary.toolCalls[0].name).toBe("bash");
      expect(summary.toolCalls[0].args).toEqual({ cmd: "echo hello" });
      expect(summary.toolCalls[0].status).toBe("success");
      expect(summary.toolCalls[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(summary.toolCalls[0].resultPreview).toBe("hello\n");
    });

    it("should mark status as error for non-zero exit codes", () => {
      const turnId = summarizer.startTurn();

      summarizer.recordToolStart("call-1", "bash", { cmd: "false" });
      summarizer.recordToolEnd("call-1", "error output", 1);

      const summary = summarizer.endTurn(turnId);

      expect(summary.toolCalls[0].status).toBe("error");
      expect(summary.exitCodes).toEqual([1]);
    });

    it("should truncate long result previews to 200 chars", () => {
      const turnId = summarizer.startTurn();
      const longResult = "x".repeat(500);

      summarizer.recordToolStart("call-1", "cat", { path: "/big.txt" });
      summarizer.recordToolEnd("call-1", longResult, 0);

      const summary = summarizer.endTurn(turnId);

      expect(summary.toolCalls[0].resultPreview.length).toBe(203); // 200 + "..."
      expect(summary.toolCalls[0].resultPreview.endsWith("...")).toBe(true);
    });

    it("should JSON.stringify non-string results", () => {
      const turnId = summarizer.startTurn();

      summarizer.recordToolStart("call-1", "api", { url: "/data" });
      summarizer.recordToolEnd("call-1", { key: "value" }, 0);

      const summary = summarizer.endTurn(turnId);

      expect(summary.toolCalls[0].resultPreview).toBe('{"key":"value"}');
    });

    it("should handle multiple tool calls in one turn", () => {
      const turnId = summarizer.startTurn();

      summarizer.recordToolStart("call-1", "bash", { cmd: "ls" });
      summarizer.recordToolStart("call-2", "read", { path: "/tmp/f.txt" });
      summarizer.recordToolEnd("call-1", "file1\nfile2", 0);
      summarizer.recordToolEnd("call-2", "contents", 0);

      const summary = summarizer.endTurn(turnId);

      expect(summary.toolCalls).toHaveLength(2);
      expect(summary.exitCodes).toEqual([0, 0]);
    });

    it("should ignore recordToolEnd if callId not found in pending", () => {
      const turnId = summarizer.startTurn();

      summarizer.recordToolEnd("nonexistent", "result", 0);

      const summary = summarizer.endTurn(turnId);
      expect(summary.toolCalls).toHaveLength(0);
    });

    it("should silently no-op when no active turn", () => {
      // No startTurn called — should not throw
      summarizer.recordToolStart("call-1", "bash", { cmd: "echo" });
      summarizer.recordToolEnd("call-1", "output", 0);
    });
  });

  describe("recordFileRead / recordFileModified", () => {
    it("should track read files", () => {
      const turnId = summarizer.startTurn();

      summarizer.recordFileRead("/src/index.ts");
      summarizer.recordFileRead("/src/utils.ts");

      const summary = summarizer.endTurn(turnId);

      expect(summary.filesRead).toContain("/src/index.ts");
      expect(summary.filesRead).toContain("/src/utils.ts");
    });

    it("should track modified files", () => {
      const turnId = summarizer.startTurn();

      summarizer.recordFileModified("/src/index.ts");
      summarizer.recordFileModified("/src/new-file.ts");

      const summary = summarizer.endTurn(turnId);

      expect(summary.filesModified).toContain("/src/index.ts");
      expect(summary.filesModified).toContain("/src/new-file.ts");
    });

    it("should deduplicate repeated file paths", () => {
      const turnId = summarizer.startTurn();

      summarizer.recordFileRead("/src/index.ts");
      summarizer.recordFileRead("/src/index.ts");
      summarizer.recordFileRead("/src/index.ts");

      const summary = summarizer.endTurn(turnId);

      expect(summary.filesRead).toHaveLength(1);
    });

    it("should silently no-op when no active turn", () => {
      summarizer.recordFileRead("/foo");
      summarizer.recordFileModified("/bar");
    });
  });

  describe("recordObservation", () => {
    it("should store observations", () => {
      const turnId = summarizer.startTurn();

      const obs: Observation = {
        type: "command_not_found",
        message: "Command 'cho' not found.",
        command: "cho",
        suggestions: ["echo"],
      };

      summarizer.recordObservation(obs);

      const summary = summarizer.endTurn(turnId);

      expect(summary.observations).toHaveLength(1);
      expect(summary.observations[0]).toEqual(obs);
    });

    it("should accumulate multiple observations", () => {
      const turnId = summarizer.startTurn();

      const obs1: Observation = {
        type: "file_not_found",
        message: "File not found",
        path: "/missing.txt",
      };
      const obs2: Observation = {
        type: "permission_denied",
        message: "Permission denied",
      };

      summarizer.recordObservation(obs1);
      summarizer.recordObservation(obs2);

      const summary = summarizer.endTurn(turnId);

      expect(summary.observations).toHaveLength(2);
    });

    it("should silently no-op when no active turn", () => {
      const obs: Observation = {
        type: "unknown",
        message: "test",
      };
      summarizer.recordObservation(obs);
    });
  });

  describe("getHistory", () => {
    it("should return all turns when no count specified", () => {
      for (let i = 0; i < 5; i++) {
        const id = summarizer.startTurn();
        summarizer.endTurn(id);
      }

      const history = summarizer.getHistory();
      expect(history).toHaveLength(5);
    });

    it("should return last N turns when count is specified", () => {
      for (let i = 0; i < 5; i++) {
        const id = summarizer.startTurn();
        summarizer.endTurn(id);
      }

      const history = summarizer.getHistory(2);
      expect(history).toHaveLength(2);
      expect(history[0].turnId).toBe("turn-4");
      expect(history[1].turnId).toBe("turn-5");
    });

    it("should return a defensive copy", () => {
      const id = summarizer.startTurn();
      summarizer.endTurn(id);

      const history1 = summarizer.getHistory();
      const history2 = summarizer.getHistory();
      expect(history1).not.toBe(history2);
    });

    it("should return empty array when no turns recorded", () => {
      expect(summarizer.getHistory()).toEqual([]);
      expect(summarizer.getHistory(5)).toEqual([]);
    });
  });

  describe("compactHistory", () => {
    it("should produce a string with turn digests", () => {
      const id1 = summarizer.startTurn();
      summarizer.recordToolStart("c1", "bash", { cmd: "ls" });
      summarizer.recordToolEnd("c1", "output", 0);
      summarizer.endTurn(id1);

      const id2 = summarizer.startTurn();
      summarizer.recordFileModified("/src/file.ts");
      summarizer.endTurn(id2);

      const compact = summarizer.compactHistory(1000);

      expect(compact).toContain("[Turn turn-1]");
      expect(compact).toContain("[Turn turn-2]");
      expect(compact).toContain("Tools: bash");
      expect(compact).toContain("Modified: /src/file.ts");
    });

    it("should respect token limit by dropping oldest turns", () => {
      // Create many turns with long digests
      for (let i = 0; i < 20; i++) {
        const id = summarizer.startTurn();
        summarizer.recordFileModified(`/very/long/path/to/file-${i}.ts`);
        summarizer.recordToolStart(`c${i}`, `tool-${i}`, {});
        summarizer.recordToolEnd(`c${i}`, "result", 0);
        summarizer.endTurn(id);
      }

      // Budget large enough for a few turns but not all 20
      const compact = summarizer.compactHistory(50);

      // Should contain the most recent turn(s) only
      const lines = compact.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBeLessThan(20);
      expect(lines.length).toBeGreaterThan(0);
      // Most recent should be included
      expect(compact).toContain("turn-20");
    });

    it("should return empty string when maxTokens is 0", () => {
      const id = summarizer.startTurn();
      summarizer.endTurn(id);

      const compact = summarizer.compactHistory(0);
      expect(compact).toBe("");
    });
  });

  describe("buildDigest (via endTurn)", () => {
    it("should produce readable text for tools", () => {
      const turnId = summarizer.startTurn();
      summarizer.recordToolStart("c1", "bash", {});
      summarizer.recordToolEnd("c1", "", 0);
      summarizer.recordToolStart("c2", "read", {});
      summarizer.recordToolEnd("c2", "", 1);

      const summary = summarizer.endTurn(turnId);

      expect(summary.digest).toContain("Tools: bash, read");
      expect(summary.digest).toContain("1 ok");
      expect(summary.digest).toContain("1 failed");
    });

    it("should include file modifications in digest", () => {
      const turnId = summarizer.startTurn();
      summarizer.recordFileModified("/a.ts");
      summarizer.recordFileModified("/b.ts");

      const summary = summarizer.endTurn(turnId);

      expect(summary.digest).toContain("Modified: /a.ts, /b.ts");
    });

    it("should include file reads in digest", () => {
      const turnId = summarizer.startTurn();
      summarizer.recordFileRead("/config.json");

      const summary = summarizer.endTurn(turnId);

      expect(summary.digest).toContain("Read: /config.json");
    });

    it("should include observation types in digest", () => {
      const turnId = summarizer.startTurn();
      summarizer.recordObservation({
        type: "command_not_found",
        message: "test",
      });
      summarizer.recordObservation({
        type: "permission_denied",
        message: "test",
      });

      const summary = summarizer.endTurn(turnId);

      expect(summary.digest).toContain(
        "Observations: command_not_found, permission_denied",
      );
    });

    it("should deduplicate tool names in digest", () => {
      const turnId = summarizer.startTurn();
      summarizer.recordToolStart("c1", "bash", {});
      summarizer.recordToolEnd("c1", "", 0);
      summarizer.recordToolStart("c2", "bash", {});
      summarizer.recordToolEnd("c2", "", 0);

      const summary = summarizer.endTurn(turnId);

      // "bash" should appear once in tool names
      expect(summary.digest).toContain("Tools: bash (2 ok)");
    });

    it("should report 'No activity' for empty turns", () => {
      const turnId = summarizer.startTurn();
      const summary = summarizer.endTurn(turnId);

      expect(summary.digest).toBe("No activity");
    });
  });

  describe("multiple turns accumulate in history", () => {
    it("should preserve all completed turns", () => {
      const id1 = summarizer.startTurn();
      summarizer.recordToolStart("c1", "bash", { cmd: "echo 1" });
      summarizer.recordToolEnd("c1", "1", 0);
      summarizer.endTurn(id1);

      const id2 = summarizer.startTurn();
      summarizer.recordFileModified("/src/main.ts");
      summarizer.recordObservation({ type: "suggestion", message: "hint" });
      summarizer.endTurn(id2);

      const id3 = summarizer.startTurn();
      summarizer.recordToolStart("c2", "read", { path: "/x" });
      summarizer.recordToolEnd("c2", "content", 0);
      summarizer.recordFileRead("/x");
      summarizer.endTurn(id3);

      const history = summarizer.getHistory();
      expect(history).toHaveLength(3);

      expect(history[0].toolCalls).toHaveLength(1);
      expect(history[1].filesModified).toEqual(["/src/main.ts"]);
      expect(history[1].observations).toHaveLength(1);
      expect(history[2].filesRead).toEqual(["/x"]);
    });
  });

  describe("estimatedTokens", () => {
    it("should estimate based on digest length / 4", () => {
      const turnId = summarizer.startTurn();
      summarizer.recordToolStart("c1", "bash", { cmd: "ls" });
      summarizer.recordToolEnd("c1", "files", 0);

      const summary = summarizer.endTurn(turnId);

      const expected = Math.ceil(summary.digest.length / 4);
      expect(summary.estimatedTokens).toBe(expected);
    });
  });
});
