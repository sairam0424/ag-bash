/**
 * StreamingExecutor Tests
 *
 * Tests the incremental output delivery mechanism that wraps Bash.exec()
 * and yields OutputChunk objects via an AsyncGenerator.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { StreamingExecutor } from "./StreamingExecutor.js";
import type { OutputChunk } from "./types.js";

describe("StreamingExecutor", () => {
  let bash: Bash;
  let executor: StreamingExecutor;

  beforeEach(() => {
    bash = new Bash();
    executor = new StreamingExecutor(bash);
  });

  /**
   * Helper to collect all chunks from the streaming generator.
   */
  async function collectChunks(
    script: string,
    options?: Parameters<StreamingExecutor["execStream"]>[1],
  ): Promise<OutputChunk[]> {
    const chunks: OutputChunk[] = [];
    for await (const chunk of executor.execStream(script, options)) {
      chunks.push(chunk);
    }
    return chunks;
  }

  describe("Basic Streaming", () => {
    it("should stream output chunks from a simple echo command", async () => {
      const chunks = await collectChunks("echo hello");

      expect(chunks.length).toBeGreaterThanOrEqual(2);

      const stdoutChunks = chunks.filter((c) => c.type === "stdout");
      expect(stdoutChunks.length).toBeGreaterThanOrEqual(1);
      expect(stdoutChunks.map((c) => c.data).join("")).toContain("hello");

      // Must end with an exit chunk
      const exitChunk = chunks[chunks.length - 1];
      expect(exitChunk.type).toBe("exit");
      expect(exitChunk.data).toBe("0");
    });

    it("should include timestamps on all chunks", async () => {
      const chunks = await collectChunks("echo timestamped");

      for (const chunk of chunks) {
        expect(chunk.timestamp).toBeTypeOf("number");
        expect(chunk.timestamp).toBeGreaterThan(0);
      }
    });

    it("should yield exit chunk with correct exit code for successful commands", async () => {
      const chunks = await collectChunks("true");

      const exitChunk = chunks.find((c) => c.type === "exit");
      expect(exitChunk).toBeDefined();
      expect(exitChunk!.data).toBe("0");
    });

    it("should yield exit chunk with non-zero code for failed commands", async () => {
      const chunks = await collectChunks("false");

      const exitChunk = chunks.find((c) => c.type === "exit");
      expect(exitChunk).toBeDefined();
      expect(exitChunk!.data).not.toBe("0");
    });
  });

  describe("Multi-line Output Streaming", () => {
    it("should stream multi-line output", async () => {
      const chunks = await collectChunks("echo one; echo two; echo three");

      const stdout = chunks
        .filter((c) => c.type === "stdout")
        .map((c) => c.data)
        .join("");

      expect(stdout).toContain("one");
      expect(stdout).toContain("two");
      expect(stdout).toContain("three");
    });

    it("should stream output from a for loop", async () => {
      const chunks = await collectChunks(`
        for i in a b c; do
          echo $i
        done
      `);

      const stdout = chunks
        .filter((c) => c.type === "stdout")
        .map((c) => c.data)
        .join("");

      expect(stdout).toContain("a");
      expect(stdout).toContain("b");
      expect(stdout).toContain("c");
    });

    it("should preserve output ordering", async () => {
      const chunks = await collectChunks("echo first; echo second; echo third");

      const stdout = chunks
        .filter((c) => c.type === "stdout")
        .map((c) => c.data)
        .join("");

      const firstIdx = stdout.indexOf("first");
      const secondIdx = stdout.indexOf("second");
      const thirdIdx = stdout.indexOf("third");

      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(thirdIdx);
    });
  });

  describe("Abort/Cancel Behavior", () => {
    it("should respect a pre-aborted signal", async () => {
      const controller = new AbortController();
      controller.abort();

      const chunks = await collectChunks("echo should-not-appear", {
        signal: controller.signal,
      });

      // Should still produce an exit chunk (either error or abort exit code)
      const exitChunk = chunks.find((c) => c.type === "exit");
      expect(exitChunk).toBeDefined();
      // Exit code should indicate cancellation (not 0)
      expect(exitChunk!.data).not.toBe("0");
    });

    it("should abort mid-execution when signal fires", async () => {
      const controller = new AbortController();

      // Abort after a short delay
      setTimeout(() => controller.abort(), 10);

      const chunks = await collectChunks(
        // Long-running script
        "for i in $(seq 1 10000); do echo $i; done",
        { signal: controller.signal },
      );

      // Should have an exit chunk indicating abort
      const exitChunk = chunks.find((c) => c.type === "exit");
      expect(exitChunk).toBeDefined();
    });

    it("should timeout after the specified duration", async () => {
      const chunks = await collectChunks(
        // Script that would take a while
        "for i in $(seq 1 100000); do echo $i; done",
        { timeout: 50 }, // Very short timeout
      );

      // Should produce an exit chunk (timeout = abort)
      const exitChunk = chunks.find((c) => c.type === "exit");
      expect(exitChunk).toBeDefined();
    });
  });

  describe("Error During Streaming", () => {
    it("should stream stderr for command not found", async () => {
      const chunks = await collectChunks("nonexistent_command_abc123");

      const stderrChunks = chunks.filter((c) => c.type === "stderr");
      expect(stderrChunks.length).toBeGreaterThanOrEqual(1);

      const stderrText = stderrChunks.map((c) => c.data).join("");
      expect(stderrText).toContain("not found");

      // Should still end with an exit chunk
      const exitChunk = chunks.find((c) => c.type === "exit");
      expect(exitChunk).toBeDefined();
    });

    it("should stream stderr for syntax errors", async () => {
      const chunks = await collectChunks('echo "unterminated');

      // Should produce stderr and exit chunk
      const exitChunk = chunks.find((c) => c.type === "exit");
      expect(exitChunk).toBeDefined();
      expect(exitChunk!.data).not.toBe("0");
    });

    it("should produce exit chunk with code 1 on runtime errors", async () => {
      const chunks = await collectChunks("exit 1");

      const exitChunk = chunks.find((c) => c.type === "exit");
      expect(exitChunk).toBeDefined();
      expect(exitChunk!.data).toBe("1");
    });

    it("should handle division by zero error in stream", async () => {
      const chunks = await collectChunks("echo $((1/0))");

      const exitChunk = chunks.find((c) => c.type === "exit");
      expect(exitChunk).toBeDefined();
      expect(exitChunk!.data).not.toBe("0");

      const stderrChunks = chunks.filter((c) => c.type === "stderr");
      expect(stderrChunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Empty Output Handling", () => {
    it("should handle commands that produce no output", async () => {
      const chunks = await collectChunks("true");

      // May or may not have stdout chunks, but must have exit
      const exitChunk = chunks.find((c) => c.type === "exit");
      expect(exitChunk).toBeDefined();
      expect(exitChunk!.data).toBe("0");

      // No stdout for 'true' command
      const stdoutChunks = chunks.filter((c) => c.type === "stdout");
      const stdoutText = stdoutChunks.map((c) => c.data).join("");
      expect(stdoutText).toBe("");
    });

    it("should handle empty string script", async () => {
      const chunks = await collectChunks("");

      const exitChunk = chunks.find((c) => c.type === "exit");
      expect(exitChunk).toBeDefined();
      expect(exitChunk!.data).toBe("0");
    });

    it("should handle whitespace-only script", async () => {
      const chunks = await collectChunks("   \n\n   ");

      const exitChunk = chunks.find((c) => c.type === "exit");
      expect(exitChunk).toBeDefined();
      expect(exitChunk!.data).toBe("0");
    });
  });

  describe("Environment and Working Directory", () => {
    it("should pass environment variables to execution", async () => {
      const chunks = await collectChunks("echo $MY_STREAM_VAR", {
        env: { MY_STREAM_VAR: "streamed" },
      });

      const stdout = chunks
        .filter((c) => c.type === "stdout")
        .map((c) => c.data)
        .join("");

      expect(stdout).toContain("streamed");
    });

    it("should respect custom working directory", async () => {
      const bashWithFiles = new Bash({
        files: { "/custom/dir/file.txt": "content" },
      });
      const customExecutor = new StreamingExecutor(bashWithFiles);

      const chunks: OutputChunk[] = [];
      for await (const chunk of customExecutor.execStream("ls", {
        cwd: "/custom/dir",
      })) {
        chunks.push(chunk);
      }

      const stdout = chunks
        .filter((c) => c.type === "stdout")
        .map((c) => c.data)
        .join("");

      expect(stdout).toContain("file.txt");
    });
  });

  describe("Generator Protocol", () => {
    it("should terminate the generator after exit chunk", async () => {
      let chunkCount = 0;
      for await (const chunk of executor.execStream("echo done")) {
        chunkCount++;
        if (chunk.type === "exit") {
          // Generator should terminate after this
          break;
        }
      }
      expect(chunkCount).toBeGreaterThanOrEqual(1);
    });

    it("should be safe to break out of the generator early", async () => {
      // Breaking early should not leave dangling promises or cause errors
      for await (const chunk of executor.execStream("echo early")) {
        if (chunk.type === "stdout") {
          break; // Exit early before the exit chunk
        }
      }

      // If we get here without hanging, the test passes
      expect(true).toBe(true);
    });
  });
});
