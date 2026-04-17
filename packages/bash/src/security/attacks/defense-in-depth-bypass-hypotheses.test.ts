import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DefenseInDepthBox,
  SecurityViolationError,
} from "../defense-in-depth-box.js";
import type { SecurityViolation } from "../types.js";

describe("Defense-in-Depth Bypass Hypotheses", () => {
  let violations: SecurityViolation[] = [];

  beforeEach(() => {
    violations = [];
  });

  afterEach(() => {
    DefenseInDepthBox.resetInstance();
  });

  it("H1: pre-captured process.binding can still be called inside sandbox context", async () => {
    // Note: in many environments process.binding is already removed or protected.
    // We use it here as a hypothesis for function pre-capture.
    const capturedBinding = (
      process as unknown as { binding: (name: string) => unknown }
    ).binding;
    if (typeof capturedBinding !== "function") {
      it.skip("process.binding not available");
      return;
    }

    const box = DefenseInDepthBox.getInstance({
      enabled: true,
      onViolation: (v) => violations.push(v),
    });
    const handle = box.activate();

    let directError: Error | undefined;
    let bypassValue: unknown;
    let bypassError: Error | undefined;

    await handle.run(async () => {
      try {
        (process as unknown as { binding: (name: string) => unknown }).binding(
          "fs",
        );
      } catch (e) {
        directError = e as Error;
      }

      try {
        bypassValue = capturedBinding("fs");
      } catch (e) {
        bypassError = e as Error;
      }
    });

    handle.deactivate();

    expect(directError).toBeInstanceOf(SecurityViolationError);
    // ADVISORY: pre-captured process.binding access bypasses monkey-patching
    // This is a known limitation of this secondary defense layer.
    expect(bypassValue).toBeDefined();
    expect(bypassError).toBeUndefined();
    expect(violations.some((v) => v.type === "process_binding")).toBe(true);
  });

  it("H2: pre-captured process.env object bypasses sandbox-time process.env proxy", async () => {
    const probeKey = "__JB_DEFENSE_ENV_PROBE__";
    const probeValue = `probe-${Date.now()}`;
    process.env[probeKey] = probeValue;
    const capturedEnv = process.env;

    const box = DefenseInDepthBox.getInstance({ enabled: true });
    const handle = box.activate();

    let directError: Error | undefined;
    let bypassValue: string | undefined;
    let bypassError: Error | undefined;

    await handle.run(async () => {
      try {
        const _blocked = process.env[probeKey];
      } catch (e) {
        directError = e as Error;
      }

      try {
        bypassValue = capturedEnv[probeKey];
      } catch (e) {
        bypassError = e as Error;
      }
    });

    handle.deactivate();
    delete process.env[probeKey];

    expect(directError).toBeInstanceOf(SecurityViolationError);
    // ADVISORY: pre-captured process.env access bypasses monkey-patching
    // This is a known limitation of this secondary defense layer.
    expect(bypassValue).toBe(probeValue);
    expect(bypassError).toBeUndefined();
  });

  it("H3: Object.defineProperty can shadow blocked process.binding inside sandbox context", async () => {
    const box = DefenseInDepthBox.getInstance({ enabled: true });
    const handle = box.activate();

    let shadowError: Error | undefined;

    await handle.run(async () => {
      try {
        Object.defineProperty(process, "binding", {
          value: () => "shadow-binding-ok",
          writable: true,
          configurable: true,
        });
      } catch (e) {
        shadowError = e as Error;
      }
    });

    handle.deactivate();

    // With our new Object.defineProperty protection, this attack is now blocked!
    expect(shadowError).toBeInstanceOf(SecurityViolationError);
    expect(shadowError?.message).toContain("shadowing");
  });

  it("H4: prototype mutation on Object.prototype to leak globals", async () => {
    const box = DefenseInDepthBox.getInstance({ enabled: true });
    const handle = box.activate();

    let mutationError: Error | undefined;

    await handle.run(async () => {
      try {
        // Attack: attempt to add a getter to Object.prototype that returns Function
        Object.defineProperty(Object.prototype, "__leak__", {
          get: () => {
            return (async () => {}).constructor("return process")();
          },
          configurable: true,
        });
      } catch (e) {
        mutationError = e as Error;
      }
    });

    handle.deactivate();

    // Defense-in-depth blocks Object.prototype mutation by default
    expect(mutationError).toBeInstanceOf(SecurityViolationError);
  });

  it("H5: leaking via JSON.stringify/JSON.parse mutation", async () => {
    const box = DefenseInDepthBox.getInstance({ enabled: true });
    const handle = box.activate();

    let mutationError: Error | undefined;

    await handle.run(async () => {
      try {
        // Attack: replace JSON.stringify to capture objects
        const originalStringify = JSON.stringify;
        JSON.stringify = function (obj: unknown) {
          return originalStringify(obj);
        };
      } catch (e) {
        mutationError = e as Error;
      }
      try {
        Object.defineProperty(JSON, "parse", { value: () => ({}) });
      } catch (err) {
        // JSON blocking prevents hijacking these channels.
        // It may throw a SecurityViolationError (if patched via Proxy)
        // or a TypeError (if the property was made non-writable).
        if (err instanceof SecurityViolationError || err instanceof TypeError) {
          return;
        }
      }
    });

    handle.deactivate();

    // JSON blocking prevents hijacking these channels
    try {
      expect(mutationError).toBeDefined();
      if (!(mutationError instanceof SecurityViolationError)) {
        expect(mutationError).toBeInstanceOf(TypeError);
      }
    } catch (e) {
      if (
        mutationError instanceof SecurityViolationError ||
        mutationError instanceof TypeError
      ) {
        return;
      }
      throw e;
    }
  });
});
