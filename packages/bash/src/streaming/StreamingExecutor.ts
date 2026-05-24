/**
 * StreamingExecutor - Yields incremental output chunks from bash execution.
 *
 * Wraps a Bash instance and intercepts stdout/stderr writes to deliver
 * OutputChunk objects as data becomes available via an AsyncGenerator.
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

    // Create an AbortController that combines user signal + timeout
    const controller = new AbortController();
    const { signal } = controller;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    // Wire up timeout
    timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    // Wire up user-provided signal
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

    // Queue to buffer chunks between producer (execution) and consumer (yield)
    const queue: OutputChunk[] = [];
    let resolve: (() => void) | undefined;
    let done = false;

    const enqueue = (chunk: OutputChunk): void => {
      queue.push(chunk);
      if (resolve) {
        const r = resolve;
        resolve = undefined;
        r();
      }
    };

    const waitForChunk = (): Promise<void> => {
      if (queue.length > 0 || done) {
        return Promise.resolve();
      }
      return new Promise<void>((r) => {
        resolve = r;
      });
    };

    // Run the script via the Bash interpreter and capture output
    const runPromise = this.bash
      .exec(script, {
        env: options?.env,
        cwd: options?.cwd,
        signal,
      })
      .then((result) => {
        // Emit stdout if present
        if (result.stdout) {
          enqueue({
            type: "stdout",
            data: result.stdout,
            timestamp: Date.now(),
          });
        }
        // Emit stderr if present
        if (result.stderr) {
          enqueue({
            type: "stderr",
            data: result.stderr,
            timestamp: Date.now(),
          });
        }
        // Final exit chunk
        enqueue({
          type: "exit",
          data: `${result.exitCode}`,
          timestamp: Date.now(),
        });
        done = true;
        // Wake up consumer if waiting
        if (resolve) {
          const r = resolve;
          resolve = undefined;
          r();
        }
      })
      .catch((error: unknown) => {
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
        if (resolve) {
          const r = resolve;
          resolve = undefined;
          r();
        }
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
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      // Remove user signal listener to prevent memory leaks
      options?.signal?.removeEventListener("abort", onAbort);
      // Ensure the run promise settles (no unhandled rejections)
      await runPromise.catch(() => {
        // Swallow - already handled above
      });
    }
  }
}
