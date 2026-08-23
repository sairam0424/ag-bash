/**
 * U17 — ControlFlowError must not be swallowed by builtin-dispatch.
 *
 * `executeExternalCommand()` wraps `cmd.execute()` in a try/catch that used to
 * re-throw only `ExecutionLimitError` and `SecurityViolationError`. Every other
 * throw — including every `ControlFlowError` subclass — was converted into a
 * generic `failure()`, so a registered command asking the script to stop
 * (`ExitError(3)`) instead reported a per-command failure, let the rest of the
 * script run, and surfaced the internal marker message ("exit") as if it were a
 * real command error. Anything reading the exit status (`&&` chains, CI, an
 * agent) then reasons from a false signal.
 *
 * These tests drive the fix through the PUBLIC surface (`customCommands`), which
 * is exactly how host extensions reach this code path.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import type { Command } from "../types.js";
import {
  ControlFlowError,
  ExecutionLimitError,
  ExitError,
  isControlFlowError,
  PosixFatalError,
} from "./errors.js";

/** A registered command whose sole job is to throw. */
function throwingCommand(name: string, makeError: () => unknown): Command {
  return {
    name,
    execute: async () => {
      throw makeError();
    },
  };
}

describe("builtin-dispatch: control-flow propagation (U17)", () => {
  it("propagates ExitError(3) from a registered command as exit status 3", async () => {
    const bash = new Bash({
      customCommands: [throwingCommand("pexit", () => new ExitError(3))],
    });

    const result = await bash.exec(
      'echo before\npexit\necho "AFTER-SHOULD-NOT-RUN"',
    );

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("before\n");
    expect(result.stdout).not.toContain("AFTER-SHOULD-NOT-RUN");
    // The internal marker message must not be reported as a command failure.
    expect(result.stderr).not.toContain("pexit: exit");
  });

  it("carries the ExitError's own stdout/stderr instead of a synthesised failure", async () => {
    const bash = new Bash({
      customCommands: [
        throwingCommand(
          "pexit2",
          () => new ExitError(42, "partial-out\n", "partial-err\n"),
        ),
      ],
    });

    const result = await bash.exec("pexit2");

    expect(result.exitCode).toBe(42);
    expect(result.stderr).toBe("partial-err\n");
  });

  it("short-circuits an && chain when a registered command exits non-zero", async () => {
    const bash = new Bash({
      customCommands: [throwingCommand("pexit3", () => new ExitError(3))],
    });

    const result = await bash.exec("pexit3 && echo REACHED");

    expect(result.exitCode).toBe(3);
    expect(result.stdout).not.toContain("REACHED");
  });

  it("propagates PosixFatalError with its own exit status", async () => {
    const bash = new Bash({
      customCommands: [
        throwingCommand(
          "pfatal",
          () => new PosixFatalError(7, "", "bash: pfatal: fatal\n"),
        ),
      ],
    });

    const result = await bash.exec('pfatal\necho "AFTER-SHOULD-NOT-RUN"');

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe("bash: pfatal: fatal\n");
    expect(result.stdout).not.toContain("AFTER-SHOULD-NOT-RUN");
  });

  it("still propagates ExecutionLimitError (regression guard for the pre-existing guard)", async () => {
    const bash = new Bash({
      customCommands: [
        throwingCommand(
          "plimit",
          () => new ExecutionLimitError("too many commands", "commands"),
        ),
      ],
    });

    const result = await bash.exec('plimit\necho "AFTER-SHOULD-NOT-RUN"');

    expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    expect(result.stdout).not.toContain("AFTER-SHOULD-NOT-RUN");
  });
});

describe("isControlFlowError branded predicate (U17)", () => {
  it("recognises every control-flow subclass", () => {
    expect(isControlFlowError(new ExitError(1))).toBe(true);
    expect(isControlFlowError(new PosixFatalError(1))).toBe(true);
    expect(isControlFlowError(new ExecutionLimitError("x", "commands"))).toBe(
      true,
    );
  });

  it("brands subclasses declared outside this module", () => {
    // ControlFlowError is exported so out-of-module control flow (a host
    // extension, another bundle) can participate in the same contract.
    class CustomFlowError extends ControlFlowError {
      readonly name = "CustomFlowError";
    }

    expect(isControlFlowError(new CustomFlowError("custom"))).toBe(true);
  });

  it("does not rely on instanceof — survives a severed prototype chain", () => {
    const err = new ExitError(5);
    Object.setPrototypeOf(err, null);

    expect(err instanceof ExitError).toBe(false);
    expect(isControlFlowError(err)).toBe(true);
  });

  it("rejects unrelated errors and forged look-alikes", () => {
    expect(isControlFlowError(new Error("boom"))).toBe(false);
    expect(isControlFlowError(undefined)).toBe(false);
    expect(isControlFlowError(null)).toBe(false);
    expect(isControlFlowError("ExitError")).toBe(false);

    // Name-spoofing must not be enough (the old `error.name === "ExitError"`
    // fallback pattern is forgeable by any plain Error).
    const forged = new Error("nope");
    Object.defineProperty(forged, "name", { value: "ExitError" });
    expect(isControlFlowError(forged)).toBe(false);

    // A JSON round-trip cannot carry the brand, so deserialised payloads are
    // never mistaken for control flow.
    expect(
      isControlFlowError(JSON.parse('{"exitCode":3,"name":"ExitError"}')),
    ).toBe(false);
  });

  it("brand is a non-enumerable, non-writable, non-configurable own property", () => {
    const err = new ExitError(1);
    const brand = Symbol.for("@ag-bash/bash.ControlFlowError");
    const descriptor = Object.getOwnPropertyDescriptor(err, brand);

    expect(descriptor).toEqual({
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    // Spreading (which copies only enumerable own props) must not carry it,
    // so clones of a control-flow error are not themselves control flow.
    expect(isControlFlowError({ ...err })).toBe(false);
  });

  it("ignores a brand inherited through the prototype chain", () => {
    // The brand symbol is reachable via Symbol.for(), so anything that can
    // pollute a prototype could otherwise forge it wholesale. Own-property
    // lookup is what makes that impossible. (Probed on a synthetic prototype
    // rather than Object.prototype so the unit config's isolate:false workers
    // cannot observe a mutated intrinsic.)
    const brand = Symbol.for("@ag-bash/bash.ControlFlowError");
    const pollutedProto = Object.create(null);
    Object.defineProperty(pollutedProto, brand, { value: true });
    const impostor = Object.create(pollutedProto);

    expect((impostor as Record<symbol, unknown>)[brand]).toBe(true);
    expect(isControlFlowError(impostor)).toBe(false);
  });
});
