/**
 * State-Sync unit tests.
 *
 * Tests diffState, diffFs, and applyStateDelta for correct delta
 * generation, filesystem diffing, and round-trip consistency.
 */

import { describe, expect, it } from "vitest";
import type { BashSnapshot } from "../Bash.js";
import type { FileSystemSnapshot } from "../fs/interface.js";
import type { InterpreterState } from "../interpreter/types.js";
import {
  applyStateDelta,
  type BashDelta,
  diffFs,
  diffState,
} from "./index.js";

/* ================================================================== */
/*  Helpers                                                            */
/* ================================================================== */

/**
 * Creates a minimal mock BashSnapshot with the given env, cwd, and functions.
 */
function createSnapshot(opts: {
  env?: Record<string, string>;
  cwd?: string;
  functions?: Record<string, unknown>;
}): BashSnapshot {
  const env = new Map<string, string>(Object.entries(opts.env ?? {}));
  const functions = new Map<string, unknown>(
    Object.entries(opts.functions ?? {}),
  );

  return {
    state: {
      env,
      cwd: opts.cwd ?? "/home/user",
      functions,
    } as unknown as InterpreterState,
    fs: undefined as unknown as FileSystemSnapshot,
  };
}

/**
 * Creates a minimal InterpreterState for applyStateDelta tests.
 */
function createState(opts: {
  env?: Record<string, string>;
  cwd?: string;
  functions?: Record<string, unknown>;
}): InterpreterState {
  const env = new Map<string, string>(Object.entries(opts.env ?? {}));
  const functions = new Map<string, unknown>(
    Object.entries(opts.functions ?? {}),
  );

  return {
    env,
    cwd: opts.cwd ?? "/home/user",
    functions,
  } as unknown as InterpreterState;
}

/**
 * Creates a mock VFS map for diffFs tests.
 * Returns as FileSystemSnapshot (opaque branded type) for type compatibility.
 */
function createFsMap(files: Record<string, string>): FileSystemSnapshot {
  const map = new Map<string, { type: string; content: string }>();
  for (const [path, content] of Object.entries(files)) {
    map.set(path, { type: "file", content });
  }
  return map as unknown as FileSystemSnapshot;
}

/* ================================================================== */
/*  diffState                                                          */
/* ================================================================== */

describe("diffState", () => {
  describe("environment variables", () => {
    it("detects added env vars", () => {
      const base = createSnapshot({ env: { PATH: "/usr/bin" } });
      const current = createSnapshot({
        env: { PATH: "/usr/bin", HOME: "/home/user" },
      });

      const delta = diffState(base, current);

      expect(delta.envDelta).toBeDefined();
      expect(delta.envDelta?.HOME).toBe("/home/user");
      // PATH unchanged, should not be in delta
      expect(delta.envDelta?.PATH).toBeUndefined();
    });

    it("detects removed env vars", () => {
      const base = createSnapshot({
        env: { PATH: "/usr/bin", EDITOR: "vim" },
      });
      const current = createSnapshot({ env: { PATH: "/usr/bin" } });

      const delta = diffState(base, current);

      expect(delta.envDelta).toBeDefined();
      expect(delta.envDelta?.EDITOR).toBeNull();
    });

    it("detects changed env vars", () => {
      const base = createSnapshot({ env: { PATH: "/usr/bin" } });
      const current = createSnapshot({
        env: { PATH: "/usr/local/bin:/usr/bin" },
      });

      const delta = diffState(base, current);

      expect(delta.envDelta).toBeDefined();
      expect(delta.envDelta?.PATH).toBe("/usr/local/bin:/usr/bin");
    });

    it("handles multiple changes at once", () => {
      const base = createSnapshot({
        env: { A: "1", B: "2", C: "3" },
      });
      const current = createSnapshot({
        env: { A: "1", B: "changed", D: "new" },
      });

      const delta = diffState(base, current);

      expect(delta.envDelta?.A).toBeUndefined(); // unchanged
      expect(delta.envDelta?.B).toBe("changed"); // modified
      expect(delta.envDelta?.C).toBeNull(); // removed
      expect(delta.envDelta?.D).toBe("new"); // added
    });

    it("returns no envDelta when env is identical", () => {
      const base = createSnapshot({ env: { X: "1", Y: "2" } });
      const current = createSnapshot({ env: { X: "1", Y: "2" } });

      const delta = diffState(base, current);

      expect(delta.envDelta).toBeUndefined();
    });

    it("handles empty base env", () => {
      const base = createSnapshot({ env: {} });
      const current = createSnapshot({ env: { NEW: "val" } });

      const delta = diffState(base, current);

      expect(delta.envDelta).toBeDefined();
      expect(delta.envDelta?.NEW).toBe("val");
    });

    it("handles empty current env (all removed)", () => {
      const base = createSnapshot({ env: { A: "1", B: "2" } });
      const current = createSnapshot({ env: {} });

      const delta = diffState(base, current);

      expect(delta.envDelta?.A).toBeNull();
      expect(delta.envDelta?.B).toBeNull();
    });
  });

  describe("CWD changes", () => {
    it("detects changed CWD", () => {
      const base = createSnapshot({ cwd: "/home/user" });
      const current = createSnapshot({ cwd: "/tmp" });

      const delta = diffState(base, current);

      expect(delta.cwd).toBe("/tmp");
    });

    it("does not include cwd when unchanged", () => {
      const base = createSnapshot({ cwd: "/home/user" });
      const current = createSnapshot({ cwd: "/home/user" });

      const delta = diffState(base, current);

      expect(delta.cwd).toBeUndefined();
    });
  });

  describe("functions", () => {
    it("detects added functions", () => {
      const base = createSnapshot({ functions: {} });
      const funcNode = { type: "function_def", name: "greet" };
      const current = createSnapshot({ functions: { greet: funcNode } });

      const delta = diffState(base, current);

      expect(delta.funcDelta).toBeDefined();
      expect(delta.funcDelta?.greet).toBe("MODIFIED");
    });

    it("detects removed functions", () => {
      const funcNode = { type: "function_def", name: "old" };
      const base = createSnapshot({ functions: { old: funcNode } });
      const current = createSnapshot({ functions: {} });

      const delta = diffState(base, current);

      expect(delta.funcDelta).toBeDefined();
      expect(delta.funcDelta?.old).toBeNull();
    });

    it("detects modified functions (different reference)", () => {
      const nodeV1 = { type: "function_def", name: "fn", body: "v1" };
      const nodeV2 = { type: "function_def", name: "fn", body: "v2" };

      const base = createSnapshot({ functions: { fn: nodeV1 } });
      const current = createSnapshot({ functions: { fn: nodeV2 } });

      const delta = diffState(base, current);

      expect(delta.funcDelta?.fn).toBe("MODIFIED");
    });

    it("does not include funcDelta when functions are identical", () => {
      const sharedNode = { type: "function_def", name: "shared" };

      // Using same reference means no change
      const base = createSnapshot({ functions: {} });
      const current = createSnapshot({ functions: {} });

      // Manually set the same reference
      (base.state.functions as Map<string, unknown>).set("shared", sharedNode);
      (current.state.functions as Map<string, unknown>).set(
        "shared",
        sharedNode,
      );

      const delta = diffState(base, current);

      expect(delta.funcDelta).toBeUndefined();
    });
  });

  describe("empty diff", () => {
    it("returns empty delta for identical snapshots", () => {
      const base = createSnapshot({
        env: { PATH: "/usr/bin" },
        cwd: "/home/user",
        functions: {},
      });
      const current = createSnapshot({
        env: { PATH: "/usr/bin" },
        cwd: "/home/user",
        functions: {},
      });

      const delta = diffState(base, current);

      expect(delta.envDelta).toBeUndefined();
      expect(delta.funcDelta).toBeUndefined();
      expect(delta.cwd).toBeUndefined();
    });

    it("returns empty delta for both empty snapshots", () => {
      const base = createSnapshot({});
      const current = createSnapshot({});

      const delta = diffState(base, current);

      expect(delta.envDelta).toBeUndefined();
      expect(delta.funcDelta).toBeUndefined();
      expect(delta.cwd).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("handles env values with special characters", () => {
      const base = createSnapshot({ env: {} });
      const current = createSnapshot({
        env: {
          GREETING: "hello\nworld",
          QUOTE: 'say "hi"',
          EMPTY: "",
        },
      });

      const delta = diffState(base, current);

      expect(delta.envDelta?.GREETING).toBe("hello\nworld");
      expect(delta.envDelta?.QUOTE).toBe('say "hi"');
      expect(delta.envDelta?.EMPTY).toBe("");
    });

    it("handles large number of env vars", () => {
      const baseEnv: Record<string, string> = {};
      const currentEnv: Record<string, string> = {};

      for (let i = 0; i < 100; i++) {
        baseEnv[`VAR_${i}`] = `value_${i}`;
        currentEnv[`VAR_${i}`] = `value_${i}`;
      }
      // Change one
      currentEnv.VAR_50 = "changed";
      // Add one
      currentEnv.NEW_VAR = "new";
      // Remove one (don't include VAR_99)
      delete currentEnv.VAR_99;

      const base = createSnapshot({ env: baseEnv });
      const current = createSnapshot({ env: currentEnv });

      const delta = diffState(base, current);

      expect(delta.envDelta?.VAR_50).toBe("changed");
      expect(delta.envDelta?.NEW_VAR).toBe("new");
      expect(delta.envDelta?.VAR_99).toBeNull();
      // Unchanged vars should not appear
      expect(delta.envDelta?.VAR_0).toBeUndefined();
    });
  });
});

/* ================================================================== */
/*  diffFs                                                             */
/* ================================================================== */

describe("diffFs", () => {
  it("detects added files", () => {
    const baseFs = createFsMap({ "/file1.txt": "hello" });
    const currentFs = createFsMap({
      "/file1.txt": "hello",
      "/file2.txt": "world",
    });

    const delta = diffFs(baseFs, currentFs);

    expect(delta.modified["/file2.txt"]).toBe("world");
    expect(delta.deleted).toHaveLength(0);
  });

  it("detects removed files", () => {
    const baseFs = createFsMap({
      "/file1.txt": "hello",
      "/file2.txt": "world",
    });
    const currentFs = createFsMap({ "/file1.txt": "hello" });

    const delta = diffFs(baseFs, currentFs);

    expect(delta.deleted).toContain("/file2.txt");
    expect(Object.keys(delta.modified)).toHaveLength(0);
  });

  it("detects modified files", () => {
    const baseFs = createFsMap({ "/file.txt": "old content" });
    const currentFs = createFsMap({ "/file.txt": "new content" });

    const delta = diffFs(baseFs, currentFs);

    expect(delta.modified["/file.txt"]).toBe("new content");
    expect(delta.deleted).toHaveLength(0);
  });

  it("handles multiple simultaneous changes", () => {
    const baseFs = createFsMap({
      "/keep.txt": "same",
      "/modify.txt": "original",
      "/remove.txt": "gone",
    });
    const currentFs = createFsMap({
      "/keep.txt": "same",
      "/modify.txt": "updated",
      "/new.txt": "fresh",
    });

    const delta = diffFs(baseFs, currentFs);

    expect(delta.modified["/modify.txt"]).toBe("updated");
    expect(delta.modified["/new.txt"]).toBe("fresh");
    expect(delta.modified["/keep.txt"]).toBeUndefined();
    expect(delta.deleted).toContain("/remove.txt");
    expect(delta.deleted).not.toContain("/keep.txt");
  });

  it("returns empty delta when filesystems are identical", () => {
    const files = { "/a.txt": "a", "/b.txt": "b" };
    const baseFs = createFsMap(files);
    const currentFs = createFsMap(files);

    const delta = diffFs(baseFs, currentFs);

    expect(Object.keys(delta.modified)).toHaveLength(0);
    expect(delta.deleted).toHaveLength(0);
  });

  it("handles empty base filesystem (all files are new)", () => {
    const baseFs = createFsMap({});
    const currentFs = createFsMap({
      "/a.txt": "a",
      "/b.txt": "b",
    });

    const delta = diffFs(baseFs, currentFs);

    expect(Object.keys(delta.modified)).toHaveLength(2);
    expect(delta.deleted).toHaveLength(0);
  });

  it("handles empty current filesystem (all files deleted)", () => {
    const baseFs = createFsMap({ "/a.txt": "a", "/b.txt": "b" });
    const currentFs = createFsMap({});

    const delta = diffFs(baseFs, currentFs);

    expect(Object.keys(delta.modified)).toHaveLength(0);
    expect(delta.deleted).toHaveLength(2);
    expect(delta.deleted).toContain("/a.txt");
    expect(delta.deleted).toContain("/b.txt");
  });

  it("handles MountableFs snapshot format with base property", () => {
    const innerBase = createFsMap({ "/file.txt": "old" });
    const innerCurrent = createFsMap({ "/file.txt": "new" });

    // Simulate MountableFs snapshot wrapping
    const baseFs = { base: innerBase } as unknown as FileSystemSnapshot;
    const currentFs = { base: innerCurrent } as unknown as FileSystemSnapshot;

    const delta = diffFs(baseFs, currentFs);

    expect(delta.modified["/file.txt"]).toBe("new");
  });

  it("handles non-Map inputs gracefully (returns empty delta)", () => {
    const delta = diffFs(
      null as unknown as FileSystemSnapshot,
      null as unknown as FileSystemSnapshot,
    );

    expect(Object.keys(delta.modified)).toHaveLength(0);
    expect(delta.deleted).toHaveLength(0);
  });

  it("handles directory entries (skips non-file types)", () => {
    const baseFs = new Map<string, { type: string; content?: string }>();
    const currentFs = new Map<string, { type: string; content?: string }>();

    currentFs.set("/dir", { type: "directory" });
    currentFs.set("/file.txt", { type: "file", content: "data" });

    const delta = diffFs(
      baseFs as unknown as FileSystemSnapshot,
      currentFs as unknown as FileSystemSnapshot,
    );

    // Only files with content should appear in modified
    expect(delta.modified["/file.txt"]).toBe("data");
    expect(delta.modified["/dir"]).toBeUndefined();
  });
});

/* ================================================================== */
/*  applyStateDelta                                                    */
/* ================================================================== */

describe("applyStateDelta", () => {
  describe("env delta application", () => {
    it("adds new env vars", () => {
      const state = createState({ env: { EXISTING: "val" } });
      const delta: BashDelta = {
        envDelta: { NEW_VAR: "new_value" },
      };

      applyStateDelta(state, delta);

      expect(state.env.get("NEW_VAR")).toBe("new_value");
      expect(state.env.get("EXISTING")).toBe("val");
    });

    it("removes env vars (null value)", () => {
      const state = createState({ env: { TO_REMOVE: "bye", KEEP: "stay" } });
      const delta: BashDelta = {
        envDelta: { TO_REMOVE: null },
      };

      applyStateDelta(state, delta);

      expect(state.env.has("TO_REMOVE")).toBe(false);
      expect(state.env.get("KEEP")).toBe("stay");
    });

    it("modifies existing env vars", () => {
      const state = createState({ env: { PATH: "/old" } });
      const delta: BashDelta = {
        envDelta: { PATH: "/new" },
      };

      applyStateDelta(state, delta);

      expect(state.env.get("PATH")).toBe("/new");
    });

    it("handles mixed add/remove/modify in one delta", () => {
      const state = createState({
        env: { A: "1", B: "2", C: "3" },
      });
      const delta: BashDelta = {
        envDelta: {
          A: "changed", // modify
          B: null, // remove
          D: "added", // add
        },
      };

      applyStateDelta(state, delta);

      expect(state.env.get("A")).toBe("changed");
      expect(state.env.has("B")).toBe(false);
      expect(state.env.get("C")).toBe("3");
      expect(state.env.get("D")).toBe("added");
    });
  });

  describe("function delta application", () => {
    it("removes functions (null value)", () => {
      const state = createState({ functions: { myFunc: { body: "echo hi" } } });
      const delta: BashDelta = {
        funcDelta: { myFunc: null },
      };

      applyStateDelta(state, delta);

      expect(state.functions.has("myFunc")).toBe(false);
    });

    it("handles removing non-existent function gracefully", () => {
      const state = createState({ functions: {} });
      const delta: BashDelta = {
        funcDelta: { ghost: null },
      };

      // Should not throw
      expect(() => applyStateDelta(state, delta)).not.toThrow();
    });
  });

  describe("CWD delta application", () => {
    it("applies new CWD", () => {
      const state = createState({ cwd: "/old/path" });
      const delta: BashDelta = { cwd: "/new/path" };

      applyStateDelta(state, delta);

      expect(state.cwd).toBe("/new/path");
    });

    it("does not change CWD when delta.cwd is undefined", () => {
      const state = createState({ cwd: "/original" });
      const delta: BashDelta = {};

      applyStateDelta(state, delta);

      expect(state.cwd).toBe("/original");
    });
  });

  describe("empty delta", () => {
    it("does nothing with empty delta", () => {
      const state = createState({
        env: { A: "1" },
        cwd: "/home",
        functions: {},
      });
      const delta: BashDelta = {};

      applyStateDelta(state, delta);

      expect(state.env.get("A")).toBe("1");
      expect(state.cwd).toBe("/home");
    });
  });

  describe("round-trip consistency", () => {
    it("diffState then applyStateDelta produces equivalent state", () => {
      const base = createSnapshot({
        env: { PATH: "/usr/bin", HOME: "/home/user" },
        cwd: "/home/user",
      });
      const target = createSnapshot({
        env: { PATH: "/usr/local/bin:/usr/bin", TERM: "xterm" },
        cwd: "/tmp",
      });

      const delta = diffState(base, target);

      // Apply delta to a fresh state matching base
      const state = createState({
        env: { PATH: "/usr/bin", HOME: "/home/user" },
        cwd: "/home/user",
      });

      applyStateDelta(state, delta);

      // Verify state matches target
      expect(state.env.get("PATH")).toBe("/usr/local/bin:/usr/bin");
      expect(state.env.get("TERM")).toBe("xterm");
      expect(state.env.has("HOME")).toBe(false); // removed
      expect(state.cwd).toBe("/tmp");
    });

    it("identical state produces empty delta which is a no-op", () => {
      const snapshot = createSnapshot({
        env: { X: "1" },
        cwd: "/dir",
      });

      const delta = diffState(snapshot, snapshot);

      const state = createState({ env: { X: "1" }, cwd: "/dir" });
      applyStateDelta(state, delta);

      expect(state.env.get("X")).toBe("1");
      expect(state.cwd).toBe("/dir");
    });

    it("round-trips with all operations simultaneously", () => {
      const base = createSnapshot({
        env: { KEEP: "keep", MODIFY: "old", REMOVE: "gone" },
        cwd: "/before",
        functions: {},
      });
      const target = createSnapshot({
        env: { KEEP: "keep", MODIFY: "new", ADDED: "fresh" },
        cwd: "/after",
        functions: {},
      });

      const delta = diffState(base, target);
      const state = createState({
        env: { KEEP: "keep", MODIFY: "old", REMOVE: "gone" },
        cwd: "/before",
      });

      applyStateDelta(state, delta);

      expect(state.env.get("KEEP")).toBe("keep");
      expect(state.env.get("MODIFY")).toBe("new");
      expect(state.env.get("ADDED")).toBe("fresh");
      expect(state.env.has("REMOVE")).toBe(false);
      expect(state.cwd).toBe("/after");
    });
  });

  describe("edge cases", () => {
    it("handles env values with empty strings", () => {
      const state = createState({ env: {} });
      const delta: BashDelta = {
        envDelta: { EMPTY: "" },
      };

      applyStateDelta(state, delta);

      expect(state.env.get("EMPTY")).toBe("");
      expect(state.env.has("EMPTY")).toBe(true);
    });

    it("applies delta with only envDelta (no cwd or func changes)", () => {
      const state = createState({ env: {}, cwd: "/unchanged" });
      const delta: BashDelta = { envDelta: { X: "1" } };

      applyStateDelta(state, delta);

      expect(state.env.get("X")).toBe("1");
      expect(state.cwd).toBe("/unchanged");
    });

    it("applies delta with only cwd change", () => {
      const state = createState({ env: { A: "1" }, cwd: "/old" });
      const delta: BashDelta = { cwd: "/new" };

      applyStateDelta(state, delta);

      expect(state.env.get("A")).toBe("1");
      expect(state.cwd).toBe("/new");
    });

    it("handles very large delta with many env vars", () => {
      const state = createState({ env: {} });
      const envDelta: Record<string, string | null> = Object.create(null);

      for (let i = 0; i < 500; i++) {
        envDelta[`VAR_${i}`] = `value_${i}`;
      }

      const delta: BashDelta = { envDelta };
      applyStateDelta(state, delta);

      expect(state.env.size).toBe(500);
      expect(state.env.get("VAR_0")).toBe("value_0");
      expect(state.env.get("VAR_499")).toBe("value_499");
    });
  });
});
