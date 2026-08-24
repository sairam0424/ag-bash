/**
 * `Bash.restore()` ordering: the filesystem restore must complete BEFORE the
 * snapshot's interpreter state — and therefore its `mode` — is adopted.
 *
 * WHY THIS IS A SECURITY-SHAPED ORDERING BUG, NOT A STYLE PREFERENCE
 * -----------------------------------------------------------------
 * `fs.restore` is one of the mutating `IFileSystem` methods that the plan-mode
 * guard already classifies as destructive: the `isWriteOp` regex in
 * interpreter/defense-aware-command-context.ts lists `restore` alongside
 * `writeFile`/`rm`/`mkdir`, and the guard reads the mode LIVE off the owning
 * instance (`ctx.bash.getMode()`). So the instant a plan-mode gate exists on a
 * `Bash` instance's own `fs` — the placement the 7.0 plan needs, because
 * redirections and the public FS API both bypass the per-command wrapper —
 * `restore()` blocks itself whenever the snapshot it is restoring says
 * `mode: "plan"`, purely because it assigns the state first:
 *
 *     this.state = this.cloneState(snapshot.state);  // mode := "plan"
 *     await this.fs.restore(snapshot.fs);            // ...then a mutator
 *
 * `fork()` is `new Bash(this.options)` + `branch.restore(snap)`, so every
 * `fork()`/`speculate()` in a plan-mode session goes through that path.
 *
 * THE RED IS EMULATED, AND THAT IS THE ONLY WAY TO OBSERVE IT TODAY
 * ----------------------------------------------------------------
 * No plan-mode gate is installed on `bash.fs` in this tree yet — that is the
 * 7.0 work these tests unblock (see security/plan-mode-write-paths.test.ts,
 * where `LAYER_DIRECT: bash.fs.writeFile` is recorded as a live BYPASS). With
 * no gate, `fs.restore` cannot refuse anything, so an unmodified `fork()`
 * cannot be made to fail. The gate is therefore emulated here, in two shapes
 * that mirror the two placements the 7.0 plan can choose from:
 *
 *   - `gateInstance()`         — post-construction wrap of ONE instance's `fs`.
 *   - `withConstructionGate()` — prototype-level, so it is also present on the
 *     branches `fork()` builds internally (a subclass cannot do this: `fork()`
 *     hardcodes `new Bash(...)`, not `new this.constructor(...)`).
 *
 * Both emulations replicate the real guard exactly: throw from a mutating fs
 * method when the OWNING instance's live `getMode()` is `"plan"`, with the real
 * guard's message text. Only the error class differs — `SecurityViolationError`
 * requires a `SecurityViolation.type`, and `"plan_mode_violation"` is not in
 * that union (the production guard smuggles it in with an `as any`), so a
 * test-local error type is used rather than importing that cast.
 *
 * The first test needs no emulation at all: it asserts the ordering invariant
 * directly by recording the mode observed at the moment `fs.restore` is called.
 */
import { describe, expect, it } from "vitest";
import { Bash, type BashSnapshot } from "./Bash.js";
import type { FileSystemSnapshot } from "./fs/interface.js";
import { MountableFs } from "./fs/mountable-fs/index.js";

/** Verbatim message text of the production plan-mode guard. */
const GATE_MESSAGE =
  "security violation: Destructive operation 'fs.restore' blocked in 'plan' mode.";

/** Stands in for `SecurityViolationError` — see the header note on `as any`. */
class PlanModeGateError extends Error {}

/** A snapshot taken while in plan mode, with a file to prove the fs moved. */
async function planModeSnapshot(): Promise<BashSnapshot> {
  const source = new Bash();
  await source.exec("echo from-snapshot > /snap.txt");
  await source.exec("ag-plan enter");
  expect(source.getMode()).toBe("plan");

  const snap = await source.snapshot();
  expect(snap.state.mode).toBe("plan");
  return snap;
}

/**
 * Emulate the 7.0 plan-mode FS gate on ONE already-built instance: `fs.restore`
 * throws when that instance's live mode is "plan", exactly as the production
 * `wrapFunction` guard does.
 */
function gateInstance(bash: Bash): void {
  const real = bash.fs.restore.bind(bash.fs);
  bash.fs.restore = (snapshot: FileSystemSnapshot): Promise<void> => {
    if (bash.getMode() === "plan") {
      throw new PlanModeGateError(GATE_MESSAGE);
    }
    return real(snapshot);
  };
}

/**
 * Emulate the same gate at CONSTRUCTION time, so it is present on the branches
 * `fork()`/`speculate()` build internally.
 *
 * Ownership (which `Bash` a given `MountableFs` belongs to) is recorded on
 * entry to `Bash.restore`, because a branch does not exist until `fork()`
 * constructs it. The mode itself is still read LIVE inside `fs.restore`, so the
 * check is identical to a gate closed over `this` in the constructor. Both
 * prototypes are always put back, and the patch never outlives the callback.
 */
async function withConstructionGate<T>(body: () => Promise<T>): Promise<T> {
  const bashRestore = Bash.prototype.restore;
  const fsRestore = MountableFs.prototype.restore;
  const ownerOf = new WeakMap<MountableFs, Bash>();

  Bash.prototype.restore = function (
    this: Bash,
    snapshot: BashSnapshot,
  ): Promise<void> {
    ownerOf.set(this.fs, this);
    return bashRestore.call(this, snapshot);
  };
  MountableFs.prototype.restore = function (
    this: MountableFs,
    snapshot: FileSystemSnapshot,
  ): Promise<void> {
    if (ownerOf.get(this)?.getMode() === "plan") {
      throw new PlanModeGateError(GATE_MESSAGE);
    }
    return fsRestore.call(this, snapshot);
  };

  try {
    return await body();
  } finally {
    Bash.prototype.restore = bashRestore;
    MountableFs.prototype.restore = fsRestore;
  }
}

describe("Bash.restore() — mutator runs before the snapshot's mode is adopted", () => {
  it("calls fs.restore while still in the OLD mode, then adopts plan mode", async () => {
    const snap = await planModeSnapshot();
    const target = new Bash();
    expect(target.getMode()).toBe("execute");

    // No gate needed: record the mode observed at the fs-mutation call site.
    const modeAtFsRestore: string[] = [];
    const real = target.fs.restore.bind(target.fs);
    target.fs.restore = (fsSnap: FileSystemSnapshot): Promise<void> => {
      modeAtFsRestore.push(target.getMode());
      return real(fsSnap);
    };

    await target.restore(snap);

    expect(modeAtFsRestore).toEqual(["execute"]);
    // The snapshot's mode is still adopted — the fix reorders, it does not skip.
    expect(target.getMode()).toBe("plan");
    expect(await target.readFile("/snap.txt")).toBe("from-snapshot\n");
  });

  it("a plan-mode FS gate on the target does not block the target's own restore", async () => {
    const snap = await planModeSnapshot();
    const target = new Bash();
    gateInstance(target);

    await target.restore(snap);

    expect(target.getMode()).toBe("plan");
    expect(await target.readFile("/snap.txt")).toBe("from-snapshot\n");
  });

  it("the gate emulation is real: it DOES block a mutator in plan mode", async () => {
    // Positive control. Without this, "the restore succeeded" would be
    // indistinguishable from "the emulated gate never refuses anything".
    // Passes both before and after the reorder, by construction: the target and
    // the snapshot are both in plan mode, so the mode read at the fs-mutation
    // call site is "plan" under either ordering.
    const target = new Bash();
    gateInstance(target);
    target.setMode("plan");

    await expect(target.restore(await planModeSnapshot())).rejects.toThrow(
      GATE_MESSAGE,
    );
  });

  it("a plan-mode instance cannot escape the gate by restoring an execute-mode snapshot", async () => {
    // The other half of the ordering bug, and the reason the fix must NOT be an
    // exemption: assigning the snapshot's state first also DISARMS the gate.
    // Under the old order the target's mode becomes "execute" before
    // `fs.restore` runs, so a plan-mode session replaces its entire filesystem
    // unchallenged. (Host API only — `bash.restore` has no script-text caller;
    // `ag-snapshot restore` goes through the guarded per-command `ctx.fs`.)
    const source = new Bash();
    await source.exec("echo from-snapshot > /snap.txt");
    const snap = await source.snapshot();
    expect(snap.state.mode).toBe("execute");

    const target = new Bash();
    await target.exec("echo target > /target.txt");
    gateInstance(target);
    await target.exec("ag-plan enter");
    expect(target.getMode()).toBe("plan");

    await expect(target.restore(snap)).rejects.toThrow(GATE_MESSAGE);

    expect(target.getMode()).toBe("plan");
    expect(await target.readFile("/target.txt")).toBe("target\n");
    await expect(target.readFile("/snap.txt")).rejects.toThrow();
  });

  it("leaves state untouched when fs.restore fails (no half-restored instance)", async () => {
    const snap = await planModeSnapshot();
    const target = new Bash();
    await target.exec("export MARK=target", { persistState: true });
    await target.exec("echo target > /target.txt");

    target.fs.restore = (): Promise<void> => {
      throw new PlanModeGateError("fs backend exploded");
    };

    await expect(target.restore(snap)).rejects.toThrow("fs backend exploded");

    // The snapshot's mode must NOT have been adopted: an instance whose state
    // says "plan" while its filesystem is the pre-restore one is a state no
    // caller can reason about, and it silently arms the very gate above.
    expect(target.getMode()).toBe("execute");
    expect((await target.exec("echo $MARK")).stdout).toBe("target\n");
    expect(await target.readFile("/target.txt")).toBe("target\n");
  });
});

describe("Bash.fork()/speculate() — usable from a plan-mode parent", () => {
  it("fork() survives a construction-time plan-mode FS gate", async () => {
    await withConstructionGate(async () => {
      const parent = new Bash();
      await parent.exec("echo parent > /file.txt");
      await parent.exec("ag-plan enter");
      expect(parent.getMode()).toBe("plan");

      const branch = await parent.fork();

      expect(branch.getMode()).toBe("plan");
      expect(await branch.readFile("/file.txt")).toBe("parent\n");
    });
  });

  it("speculate() survives a construction-time plan-mode FS gate", async () => {
    await withConstructionGate(async () => {
      const parent = new Bash();
      await parent.exec("export V=base", { persistState: true });
      await parent.exec("ag-plan enter");

      const modes = await parent.speculate([
        async (b) => b.getMode(),
        async (b) => b.getMode(),
      ]);

      expect(modes).toEqual(["plan", "plan"]);
      expect(parent.getMode()).toBe("plan");
    });
  });

  it("the branch is independent of the plan-mode parent", async () => {
    const parent = new Bash();
    await parent.exec("export V=parent", { persistState: true });
    await parent.exec("echo parent > /file.txt");
    await parent.exec("ag-plan enter");

    const branch = await parent.fork();

    // The branch inherits the snapshot's mode; leaving plan mode in the branch
    // is the plan -> execute handoff the fork primitive exists to support.
    expect(branch.getMode()).toBe("plan");
    branch.setMode("execute");

    await branch.exec("export V=branch", { persistState: true });
    await branch.exec("echo branch > /file.txt");
    await branch.exec("echo branch-only > /branch.txt");

    expect((await branch.exec("echo $V")).stdout).toBe("branch\n");
    expect(await branch.readFile("/file.txt")).toBe("branch\n");

    // Parent keeps its own state, its own filesystem, AND its own mode.
    expect(parent.getMode()).toBe("plan");
    expect((await parent.exec("echo $V")).stdout).toBe("parent\n");
    expect(await parent.readFile("/file.txt")).toBe("parent\n");
    await expect(parent.readFile("/branch.txt")).rejects.toThrow();
  });

  it("the snapshot's mode wins: an execute-mode snapshot clears plan mode", async () => {
    // Ungated, so it documents the plain semantics the reorder must preserve:
    // `restore()` adopts the snapshot's mode in BOTH directions. (With a real
    // gate installed this same call is refused — correctly: mutating the
    // filesystem of a plan-mode session is exactly what the gate is for. See
    // the escape test above.)
    const source = new Bash();
    await source.exec("echo execute-snap > /snap.txt");
    const snap = await source.snapshot();
    expect(snap.state.mode).toBe("execute");

    const target = new Bash();
    await target.exec("ag-plan enter");
    expect(target.getMode()).toBe("plan");

    await target.restore(snap);

    expect(target.getMode()).toBe("execute");
    expect(await target.readFile("/snap.txt")).toBe("execute-snap\n");
  });
});
