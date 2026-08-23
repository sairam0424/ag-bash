/**
 * Teardown wiring for ServiceContainer.dispose() (U29).
 *
 * ServiceContainer.dispose() is what flushes AgentMemory to the VFS. Hydration
 * already works, so the feature LOOKS functional inside a session - but if no
 * teardown path calls dispose(), every write evaporates and the next session
 * silently reads stale disk.
 *
 * These tests assert the real round trip (write -> teardown -> rehydrate),
 * not "dispose was called".
 */

import { describe, expect, it, vi } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/in-memory-fs.js";
import { MountableFs } from "../fs/mountable-fs/index.js";

/** A MountableFs shared by two Bash instances = one "disk" across sessions. */
function createSharedDisk(): MountableFs {
  return new MountableFs({ base: new InMemoryFs() });
}

/** Second session over the same disk; returns the rehydrated memory value. */
async function rehydrateValue(
  disk: MountableFs,
  key: string,
): Promise<string | undefined> {
  const next = new Bash({ fs: disk });
  await next.services.ensureAgentMemoryHydrated();
  return next.services.agentMemory.read("planner", "project", key)?.value;
}

describe("ServiceContainer.dispose() teardown wiring", () => {
  it("control: an explicit services.dispose() flushes memory to the VFS", async () => {
    const disk = createSharedDisk();
    const bash = new Bash({ fs: disk });

    bash.services.agentMemory.write("planner", "project", "control", "kept");
    await bash.services.dispose();

    expect(await rehydrateValue(disk, "control")).toBe("kept");
  });

  it("asyncDispose flushes agent memory so the next session sees the write", async () => {
    const disk = createSharedDisk();

    {
      const bash = new Bash({ fs: disk });
      bash.services.agentMemory.write("planner", "project", "note", "survives");
      await bash[Symbol.asyncDispose]();
    }

    expect(await rehydrateValue(disk, "note")).toBe("survives");
  });

  it("`await using` flushes agent memory at scope exit", async () => {
    const disk = createSharedDisk();

    {
      await using bash = new Bash({ fs: disk });
      bash.services.agentMemory.write(
        "planner",
        "project",
        "scoped",
        "flushed",
      );
    }

    expect(await rehydrateValue(disk, "scoped")).toBe("flushed");
  });

  it("surfaces a flush failure as an AggregateError but still tears down", async () => {
    const disk = createSharedDisk();
    const bash = new Bash({ fs: disk });

    bash.services.agentMemory.write("planner", "project", "doomed", "value");
    bash.services.sharedBus.subscribe("evt", () => undefined);
    vi.spyOn(bash.fs, "writeFile").mockRejectedValue(new Error("EROFS"));

    await expect(bash[Symbol.asyncDispose]()).rejects.toThrowError(
      AggregateError,
    );

    // Teardown must complete despite the failure.
    expect(bash.services.sharedBus.subscriberCount()).toBe(0);
    expect(bash.services.astCache.stats().size).toBe(0);
  });

  it("is idempotent across repeated teardown calls", async () => {
    const disk = createSharedDisk();
    const bash = new Bash({ fs: disk });

    bash.services.agentMemory.write("planner", "project", "once", "value");
    const flushSpy = vi.spyOn(bash.fs, "writeFile");

    await bash[Symbol.asyncDispose]();
    const callsAfterFirst = flushSpy.mock.calls.length;
    await bash[Symbol.asyncDispose]();
    await bash.destroy();

    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(flushSpy.mock.calls.length).toBe(callsAfterFirst);
  });
});
