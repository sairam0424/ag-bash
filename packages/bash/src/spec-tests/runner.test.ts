/**
 * Unit tests for the spec-test runner's OUTCOME CLASSIFICATION.
 *
 * The conformance gate (scripts/check-spec-ratchet.js) buckets every case off
 * the vitest reporter status, and bash/spec.test.ts derives that status from
 * only two fields of `TestResult`: `skipped` (-> ctx.skip) and `passed`
 * (-> pass/fail). So the mapping from "what happened" to those two fields IS
 * the gate's definition of truth, and it needs its own tests: a wrong mapping
 * silently changes what the headline pass rate means.
 *
 * NOTE: kept to a SINGLE top-level `describe`. check-spec-ratchet.js keys spec
 * cases off `assertionResults[].ancestorTitles[1]` and treats a present value
 * as a case-file basename under `<suite>/cases/`. A second nesting level here
 * would make it try to read a case file that does not exist.
 */

import { describe, expect, it } from "vitest";
import type { BashOptions } from "../Bash.js";
import type { TestCase } from "./parser.js";
import { runTestCase } from "./runner.js";

const INJECTED_FAULT = "injected engine fault";

/**
 * Fault injection that makes `Bash.exec()` THROW rather than return a result.
 *
 * `debug.logger` is invoked from inside `exec()` and its calls are not guarded,
 * so a throwing logger reproduces the shape of an engine crash (an exception
 * escaping `exec()`) deterministically, without depending on a specific
 * interpreter bug that a later fix would quietly remove. `runTestCase` spreads
 * `bashEnvOptions` last into the `Bash` constructor, and the fault fires only
 * once `exec()` runs - the constructor and the pre-exec `fs.chmod` /
 * `fs.mkdir` calls still succeed, so the throw lands inside the runner's
 * try/catch, which is exactly the path under test.
 */
const throwingEngine: BashOptions = {
  debug: {
    logger: {
      info: () => {
        throw new Error(INJECTED_FAULT);
      },
      debug: () => {
        throw new Error(INJECTED_FAULT);
      },
    },
  },
};

function makeCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    name: "synthetic case",
    script: "echo hi",
    assertions: [{ type: "stdout", value: "hi" }],
    lineNumber: 1,
    ...overrides,
  };
}

describe("runTestCase outcome classification", () => {
  it("does not launder an exception in a ## SKIP case into the skip bucket", async () => {
    const testCase = makeCase({
      // A divergence the case author documented, so the case is expected to
      // fail on OUTPUT - not to crash the engine.
      assertions: [{ type: "stdout", value: "not-hi" }],
      skip: "documented stdout divergence",
    });

    const result = await runTestCase(testCase, {
      bashEnvOptions: throwingEngine,
      filePath: "synthetic.test.sh",
    });

    // A crash is not a deliberate skip. `skipped: true` here would make the
    // case unrunnable-by-accident: ctx.skip() hides it from the gate, and the
    // ratchet cannot fail on a case it never sees as failed.
    expect(result.skipped).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.errored).toBe(true);
    // The message must name the crash AND the skip marker, so a reader can
    // tell "expected divergence" from "engine blew up on an expected
    // divergence".
    expect(result.error).toContain(INJECTED_FAULT);
    expect(result.error).toContain("documented stdout divergence");
  });

  it("flags an exception in a non-SKIP case as errored, still failing", async () => {
    const result = await runTestCase(makeCase(), {
      bashEnvOptions: throwingEngine,
    });

    expect(result.skipped).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.errored).toBe(true);
    expect(result.error).toContain(INJECTED_FAULT);
  });

  it("still skips a ## SKIP case that runs and diverges as documented", async () => {
    const result = await runTestCase(
      makeCase({
        assertions: [{ type: "stdout", value: "not-hi" }],
        skip: "documented stdout divergence",
      }),
    );

    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.errored).toBeFalsy();
    expect(result.skipReason).toBe("## SKIP: documented stdout divergence");
    // It really ran - that is what separates this bucket from N-I/xtrace.
    expect(result.actualStdout).toBe("hi\n");
  });

  it("still fails a ## SKIP case that has started passing", async () => {
    const result = await runTestCase(makeCase({ skip: "stale marker" }), {
      filePath: "synthetic.test.sh",
    });

    expect(result.skipped).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.unexpectedPass).toBe(true);
    expect(result.errored).toBeFalsy();
  });

  it("skips an N-I-for-bash case without executing it", async () => {
    const result = await runTestCase(
      makeCase({
        script: "exit 7",
        assertions: [
          { type: "stdout", value: "x", variant: "N-I", shells: ["bash"] },
        ],
      }),
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("N-I (Not Implemented) for bash");
    // Never executed, so there is no observed output at all.
    expect(result.actualStdout).toBeUndefined();
    expect(result.actualStatus).toBeUndefined();
  });

  it("skips a case whose expectation needs xtrace output", async () => {
    const result = await runTestCase(
      makeCase({
        script: "set -x\necho hi",
        assertions: [{ type: "stderr", value: "+ echo hi" }],
      }),
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe(
      "xtrace (set -x) trace output not implemented",
    );
    expect(result.actualStderr).toBeUndefined();
  });
});
