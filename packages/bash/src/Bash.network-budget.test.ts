import { afterEach, describe, expect, it, vi } from "vitest";
import { Bash } from "./Bash.js";
import type { SecureFetch } from "./network/index.js";

/**
 * U60 — `executionLimits.maxNetworkTrafficBytes` must actually be enforceable.
 *
 * Two independently-broken halves are covered here:
 *
 * (a) ORDERING. `Bash.exec()` runs every script against `{ ...this.state }` —
 *     an exec-scoped COPY. The traffic accounting hook credited only
 *     `this.state.networkTrafficBytes` (the instance state), while the
 *     interpreter's statement-level guard reads `ctx.state.networkTrafficBytes`
 *     (the copy). The copy is a primitive snapshot taken before the script
 *     runs, so no amount of traffic generated DURING an exec could ever move
 *     the number the guard reads. The budget could only fire on the FIRST
 *     statement of a LATER exec.
 *
 * (b) options.fetch. A caller-supplied fetch was assigned to `this.secureFetch`
 *     verbatim, with no accounting wrapper at all, so every byte through it was
 *     invisible to the budget — precisely the case where a caller-imposed limit
 *     is the only control left.
 *
 * All traffic here comes from local stubs; the unit lane stays offline.
 */

const LIMIT_BYTES = 300;

/** A body big enough to blow LIMIT_BYTES in a single request. */
const BIG_BODY = "x".repeat(1024);

/** A body small enough that three requests are needed to blow the budget. */
const SMALL_BODY = "y".repeat(128);

function makeStubFetch(body: string): {
  fetch: SecureFetch;
  callCount: () => number;
} {
  let calls = 0;
  const fetch: SecureFetch = async (url) => {
    calls += 1;
    return {
      status: 200,
      statusText: "OK",
      headers: Object.create(null) as Record<string, string>,
      body,
      url,
    };
  };
  return { fetch, callCount: () => calls };
}

describe("maxNetworkTrafficBytes enforcement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("caller-supplied options.fetch (sub-defect b)", () => {
    it("fires when a single request overshoots the budget", async () => {
      const { fetch, callCount } = makeStubFetch(BIG_BODY);
      const bash = new Bash({
        fetch,
        executionLimits: { maxNetworkTrafficBytes: LIMIT_BYTES },
      });

      const result = await bash.exec("curl https://example.test/big");

      expect(callCount()).toBe(1);
      expect(result.stderr).toContain("network traffic limit exceeded");
      expect(result.exitCode).toBe(126);
    });

    it("fires mid-script once cumulative traffic crosses the budget", async () => {
      const { fetch } = makeStubFetch(SMALL_BODY);
      const bash = new Bash({
        fetch,
        executionLimits: { maxNetworkTrafficBytes: LIMIT_BYTES },
      });

      const result = await bash.exec(
        [
          "curl https://example.test/1 > /dev/null",
          "curl https://example.test/2 > /dev/null",
          "curl https://example.test/3 > /dev/null",
          "echo SHOULD_NOT_RUN",
        ].join("\n"),
      );

      expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
      expect(result.stderr).toContain("network traffic limit exceeded");
      expect(result.exitCode).toBe(126);
    });

    it("reports sub-megabyte budgets in bytes, not as '0MB exceeds 0MB'", async () => {
      const { fetch } = makeStubFetch(BIG_BODY);
      const bash = new Bash({
        fetch,
        executionLimits: { maxNetworkTrafficBytes: LIMIT_BYTES },
      });

      const result = await bash.exec("curl https://example.test/big");

      expect(result.stderr).toContain("1024B");
      expect(result.stderr).toContain("300B");
      expect(result.stderr).not.toContain("0MB exceeds 0MB");
    });

    it("counts the OUTGOING request body, not just the response", async () => {
      // Response body is empty, so only the uploaded payload can blow the budget.
      const { fetch, callCount } = makeStubFetch("");
      const bash = new Bash({
        fetch,
        executionLimits: { maxNetworkTrafficBytes: LIMIT_BYTES },
      });

      const payload = "z".repeat(LIMIT_BYTES + 1);
      const result = await bash.exec(
        `curl -s -X POST -d '${payload}' https://example.test/upload`,
      );

      expect(callCount()).toBe(1);
      expect(result.stderr).toContain("network traffic limit exceeded");
      expect(result.exitCode).toBe(126);
    });

    it("fires from inside a loop body, not just top-level statements", async () => {
      const { fetch, callCount } = makeStubFetch(SMALL_BODY);
      const bash = new Bash({
        fetch,
        executionLimits: { maxNetworkTrafficBytes: LIMIT_BYTES },
      });

      const result = await bash.exec(
        [
          "for i in 1 2 3 4 5 6 7 8 9 10; do",
          "  curl -s https://example.test/$i > /dev/null",
          "done",
          "echo SHOULD_NOT_RUN",
        ].join("\n"),
      );

      // 128B per request against a 300B budget: must stop well before 10.
      expect(callCount()).toBeLessThan(10);
      expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
      expect(result.stderr).toContain("network traffic limit exceeded");
      expect(result.exitCode).toBe(126);
    });

    it("fires for traffic generated inside a command substitution", async () => {
      const { fetch } = makeStubFetch(BIG_BODY);
      const bash = new Bash({
        fetch,
        executionLimits: { maxNetworkTrafficBytes: LIMIT_BYTES },
      });

      const result = await bash.exec(
        'RESP="$(curl -s https://example.test/big)"\necho SHOULD_NOT_RUN',
      );

      expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
      expect(result.stderr).toContain("network traffic limit exceeded");
      expect(result.exitCode).toBe(126);
    });

    it("stays under budget for traffic that does not cross it", async () => {
      const { fetch } = makeStubFetch(SMALL_BODY);
      const bash = new Bash({
        fetch,
        executionLimits: { maxNetworkTrafficBytes: LIMIT_BYTES },
      });

      const result = await bash.exec(
        "curl https://example.test/1 > /dev/null\necho OK",
      );

      expect(result.stderr).not.toContain("network traffic limit exceeded");
      expect(result.stdout).toContain("OK");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("built-in network path (sub-defect a)", () => {
    /**
     * Drives the real `createSecureFetch` pipeline with a stubbed global
     * `fetch`, so allow-list / redirect / accounting wiring is exercised
     * without a socket. `denyPrivateRanges: false` skips DNS entirely.
     */
    function makeNetworkBash(
      body: string,
      onTraffic?: (bytes: number) => void,
    ): Bash {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      );
      return new Bash({
        network: {
          allowedUrlPrefixes: ["https://example.test"],
          denyPrivateRanges: false,
          onTraffic,
        },
        executionLimits: { maxNetworkTrafficBytes: LIMIT_BYTES },
      });
    }

    it("fires when a single request overshoots the budget", async () => {
      const bash = makeNetworkBash(BIG_BODY);

      const result = await bash.exec("curl https://example.test/big");

      expect(result.stderr).toContain("network traffic limit exceeded");
      expect(result.exitCode).toBe(126);
    });

    it("fires mid-script once cumulative traffic crosses the budget", async () => {
      const bash = makeNetworkBash(SMALL_BODY);

      const result = await bash.exec(
        [
          "curl https://example.test/1 > /dev/null",
          "curl https://example.test/2 > /dev/null",
          "curl https://example.test/3 > /dev/null",
          "echo SHOULD_NOT_RUN",
        ].join("\n"),
      );

      expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
      expect(result.stderr).toContain("network traffic limit exceeded");
      expect(result.exitCode).toBe(126);
    });

    it("still invokes a caller-supplied network.onTraffic hook", async () => {
      const seen: number[] = [];
      const bash = makeNetworkBash(SMALL_BODY, (bytes) => {
        seen.push(bytes);
      });

      await bash.exec("curl https://example.test/1 > /dev/null");

      expect(seen.length).toBeGreaterThan(0);
      expect(seen.reduce((a, b) => a + b, 0)).toBe(SMALL_BODY.length);
    });
  });

  describe("budget is session-wide across exec() calls", () => {
    it("keeps firing on subsequent execs after the budget is blown", async () => {
      const { fetch } = makeStubFetch(BIG_BODY);
      const bash = new Bash({
        fetch,
        executionLimits: { maxNetworkTrafficBytes: LIMIT_BYTES },
      });

      const first = await bash.exec("curl https://example.test/big");
      expect(first.exitCode).toBe(126);

      const second = await bash.exec("echo hello");
      expect(second.stderr).toContain("network traffic limit exceeded");
      expect(second.exitCode).toBe(126);
    });
  });
});
