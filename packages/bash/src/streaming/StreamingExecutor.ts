/**
 * StreamingExecutor - Yields incremental output chunks from bash execution.
 *
 * Drives TRUE streaming: it injects an opt-in `onChunk` sink into bash.exec()
 * so the interpreter pushes stdout/stderr fragments to a queue AS each
 * statement produces them. The AsyncGenerator drains that queue and yields
 * chunks live, rather than awaiting the full buffered result and emitting once.
 *
 * Equivalence guarantee: the streamed sink only ever observes a PREFIX of the
 * final buffered output (statement output is appended to the interpreter's
 * buffers in the same order the sink sees it; error-path trap/exit output is
 * only ever added at the tail). After exec() settles we therefore flush any
 * un-streamed REMAINDER (e.g. EXIT-trap output, exit-builtin output, or the
 * sanitized error message produced by the buffered error path) as a final data
 * chunk before the exit chunk. This makes `concat(streamed stdout)` byte-equal
 * to `exec(script).stdout` while never double-emitting a byte.
 */

import type { Bash } from "../Bash.js";
import { sanitizeErrorMessage } from "../fs/sanitize-error.js";
import type { OutputChunk, StreamExecOptions } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30000;

export class StreamingExecutor {
  private bash: Bash;

  constructor(bash: Bash) {
    this.bash = bash;
  }

  async *execStream(
    script: string,
    options?: StreamExecOptions,
  ): AsyncGenerator<OutputChunk, void, undefined> {
    const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT_MS;

    // Combine user signal + timeout into a single AbortController.
    const controller = new AbortController();
    const { signal } = controller;

    const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    const onAbort = (): void => {
      controller.abort();
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Bounded hand-off queue between the producer (exec sink) and the consumer
    // (this generator). We never mutate chunks in place — each is a fresh
    // object — preserving immutability.
    const queue: OutputChunk[] = [];
    let resolve: (() => void) | undefined;
    let done = false;

    const wake = (): void => {
      if (resolve) {
        const r = resolve;
        resolve = undefined;
        r();
      }
    };

    const enqueue = (chunk: OutputChunk): void => {
      queue.push(chunk);
      wake();
    };

    const waitForChunk = (): Promise<void> => {
      if (queue.length > 0 || done) {
        return Promise.resolve();
      }
      return new Promise<void>((r) => {
        resolve = r;
      });
    };

    // Track how much of each stream the sink has already emitted so we can
    // compute (and flush) any tail remainder once exec() settles.
    let streamedStdoutLen = 0;
    let streamedStderrLen = 0;

    // Run the script via the interpreter with the live streaming sink. The
    // sink fires synchronously from inside executeScript as statements append
    // output, so chunks are enqueued in production order.
    const runPromise = this.bash
      .exec(script, {
        env: options?.env,
        cwd: options?.cwd,
        signal,
        onChunk: (chunk) => {
          if (chunk.type === "stdout") {
            streamedStdoutLen += chunk.data.length;
          } else {
            streamedStderrLen += chunk.data.length;
          }
          enqueue({
            type: chunk.type,
            data: chunk.data,
            timestamp: Date.now(),
          });
        },
      })
      .then((result) => {
        // Flush any output the buffered result holds but the sink never saw
        // (EXIT-trap output, exit-builtin output, error-path messages). Because
        // streamed output is always a prefix, the remainder is a clean suffix.
        const stdoutRemainder = result.stdout.slice(streamedStdoutLen);
        if (stdoutRemainder) {
          enqueue({
            type: "stdout",
            data: stdoutRemainder,
            timestamp: Date.now(),
          });
        }
        const stderrRemainder = result.stderr.slice(streamedStderrLen);
        if (stderrRemainder) {
          enqueue({
            type: "stderr",
            data: stderrRemainder,
            timestamp: Date.now(),
          });
        }
        enqueue({
          type: "exit",
          data: `${result.exitCode}`,
          timestamp: Date.now(),
        });
        done = true;
        wake();
      })
      .catch((error: unknown) => {
        // exec() converts known interpreter errors into results; reaching here
        // means an unexpected throw. Surface the (sanitized) message + exit 1,
        // accounting for whatever the sink already streamed.
        const message = sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error),
        );
        enqueue({
          type: "stderr",
          data: message,
          timestamp: Date.now(),
        });
        enqueue({
          type: "exit",
          data: "1",
          timestamp: Date.now(),
        });
        done = true;
        wake();
      });

    try {
      while (true) {
        await waitForChunk();

        while (queue.length > 0) {
          const chunk = queue.shift();
          if (chunk) {
            yield chunk;
            if (chunk.type === "exit") {
              return;
            }
          }
        }

        if (done && queue.length === 0) {
          return;
        }
      }
    } finally {
      clearTimeout(timeoutId);
      // Remove user signal listener to prevent memory leaks.
      options?.signal?.removeEventListener("abort", onAbort);
      // Ensure the run promise settles (no unhandled rejections) even if the
      // consumer broke out of the generator early.
      await runPromise.catch(() => {
        // Already handled in the .catch above.
      });
    }
  }
}
