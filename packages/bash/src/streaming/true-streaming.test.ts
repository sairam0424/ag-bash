/**
 * True Streaming Tests (task C5)
 *
 * Proves that StreamingExecutor.execStream() emits output INCREMENTALLY as
 * commands produce it (per-statement granularity) rather than awaiting the
 * full buffered exec() and emitting a single chunk.
 *
 * Coverage:
 * (a) multiple chunks for a multi-command script (incremental, not buffered)
 * (b) stdout/stderr ordering preserved
 * (c) no double-emission (each byte appears exactly once)
 * (d) equivalence: concat(streamed stdout) === buffered exec().stdout
 * (e) buffered exec() unchanged when onChunk is absent (no-op sink)
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { StreamingExecutor } from "./StreamingExecutor.js";
import type { OutputChunk } from "./types.js";

describe("StreamingExecutor — true incremental streaming", () => {
  let bash: Bash;
  let executor: StreamingExecutor;

  beforeEach(() => {
    bash = new Bash();
    executor = new StreamingExecutor(bash);
  });

  async function collect(
    script: string,
    options?: Parameters<StreamingExecutor["execStream"]>[1],
  ): Promise<OutputChunk[]> {
    const chunks: OutputChunk[] = [];
    for await (const chunk of executor.execStream(script, options)) {
      chunks.push(chunk);
    }
    return chunks;
  }

  describe("(a) incremental — multiple chunks for a multi-command script", () => {
    it("yields a separate stdout chunk per command in `echo a; echo b; echo c`", async () => {
      const chunks = await collect("echo a; echo b; echo c");

      const stdoutChunks = chunks.filter((c) => c.type === "stdout");
      // Three distinct echo statements => three incremental stdout chunks.
      // A fake (buffered-then-one-chunk) implementation would produce exactly 1.
      expect(stdoutChunks.length).toBe(3);
      expect(stdoutChunks.map((c) => c.data)).toEqual(["a\n", "b\n", "c\n"]);

      const exitChunk = chunks[chunks.length - 1];
      expect(exitChunk.type).toBe("exit");
      expect(exitChunk.data).toBe("0");
    });

    it("yields incremental chunks across top-level statements, then exit", async () => {
      // A for-loop is a SINGLE top-level statement, so its output surfaces as
      // one chunk (the interpreter buffers loop-internal output into the
      // statement result). Multiple top-level statements => multiple chunks.
      const chunks = await collect(
        "echo before; for i in a b c d; do echo $i; done; echo after",
      );
      const stdoutChunks = chunks.filter((c) => c.type === "stdout");
      // 3 top-level statements: echo before, the loop, echo after.
      expect(stdoutChunks.length).toBe(3);
      expect(stdoutChunks[0].data).toBe("before\n");
      expect(stdoutChunks[1].data).toBe("a\nb\nc\nd\n");
      expect(stdoutChunks[2].data).toBe("after\n");
      expect(chunks[chunks.length - 1].type).toBe("exit");
    });
  });

  describe("(b) ordering — stdout/stderr interleaving preserved", () => {
    it("preserves order across `echo out; echo err >&2; echo out2`", async () => {
      const chunks = await collect("echo out; echo err >&2; echo out2");

      const dataChunks = chunks.filter(
        (c) => c.type === "stdout" || c.type === "stderr",
      );

      // Expected interleaving in source order.
      expect(dataChunks.map((c) => ({ type: c.type, data: c.data }))).toEqual([
        { type: "stdout", data: "out\n" },
        { type: "stderr", data: "err\n" },
        { type: "stdout", data: "out2\n" },
      ]);
    });
  });

  describe("(c) no double-emission — each byte appears exactly once", () => {
    it("streamed stdout equals buffered stdout with no duplication", async () => {
      const script = "echo a; echo b; echo c";
      const streamed = (await collect(script))
        .filter((c) => c.type === "stdout")
        .map((c) => c.data)
        .join("");

      const freshBash = new Bash();
      const buffered = await freshBash.exec(script);

      expect(streamed).toBe(buffered.stdout);
      // Guard against accidental duplication: "a\n" appears once.
      expect(streamed.split("a\n").length - 1).toBe(1);
      expect(streamed.split("b\n").length - 1).toBe(1);
      expect(streamed.split("c\n").length - 1).toBe(1);
    });

    it("does not double-emit stderr", async () => {
      const script = "echo e1 >&2; echo e2 >&2";
      const streamed = (await collect(script))
        .filter((c) => c.type === "stderr")
        .map((c) => c.data)
        .join("");
      expect(streamed.split("e1\n").length - 1).toBe(1);
      expect(streamed.split("e2\n").length - 1).toBe(1);
    });
  });

  describe("(d) equivalence — streamed concat === buffered exec()", () => {
    const scripts = [
      "echo hello",
      "echo a; echo b; echo c",
      "for i in 1 2 3; do echo line$i; done",
      "echo out; echo err >&2; echo out2",
      "printf 'no-newline'",
      "echo $((2 + 3))",
      "x=5; echo $x; y=$((x * 2)); echo $y",
      "echo first | cat; echo second",
      "true; echo after-true",
    ];

    for (const script of scripts) {
      it(`stdout matches for: ${JSON.stringify(script)}`, async () => {
        const streamedChunks = await collect(script);
        const streamedStdout = streamedChunks
          .filter((c) => c.type === "stdout")
          .map((c) => c.data)
          .join("");
        const streamedStderr = streamedChunks
          .filter((c) => c.type === "stderr")
          .map((c) => c.data)
          .join("");

        const freshBash = new Bash();
        const buffered = await freshBash.exec(script);

        expect(streamedStdout).toBe(buffered.stdout);
        expect(streamedStderr).toBe(buffered.stderr);

        const exitChunk = streamedChunks.find((c) => c.type === "exit");
        expect(exitChunk?.data).toBe(String(buffered.exitCode));
      });
    }
  });

  describe("(e) buffered exec() unchanged when onChunk absent", () => {
    it("exec() produces identical result with and without the sink option", async () => {
      const script = "echo a; echo b >&2; echo c";

      const bashA = new Bash();
      const withoutSink = await bashA.exec(script);

      const bashB = new Bash();
      const collected: Array<{ type: string; data: string }> = [];
      const withSink = await bashB.exec(script, {
        onChunk: (chunk) => {
          collected.push({ type: chunk.type, data: chunk.data });
        },
      });

      // The buffered result must be byte-identical regardless of the sink.
      expect(withSink.stdout).toBe(withoutSink.stdout);
      expect(withSink.stderr).toBe(withoutSink.stderr);
      expect(withSink.exitCode).toBe(withoutSink.exitCode);

      // And the sink must have observed the same bytes, in order.
      const sinkStdout = collected
        .filter((c) => c.type === "stdout")
        .map((c) => c.data)
        .join("");
      expect(sinkStdout).toBe(withoutSink.stdout);
    });
  });

  describe("public Bash.execStream API", () => {
    it("is exposed on the Bash instance and streams incrementally", async () => {
      const direct = new Bash();
      const chunks: OutputChunk[] = [];
      for await (const chunk of direct.execStream("echo x; echo y")) {
        chunks.push(chunk);
      }
      const stdoutChunks = chunks.filter((c) => c.type === "stdout");
      expect(stdoutChunks.length).toBe(2);
      expect(chunks[chunks.length - 1].type).toBe("exit");
    });
  });
});
