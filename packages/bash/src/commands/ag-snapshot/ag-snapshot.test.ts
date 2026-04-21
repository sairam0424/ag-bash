import { describe, it, expect, beforeEach } from "vitest";
import { agSnapshotCommand } from "./ag-snapshot.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";

describe("ag-snapshot", () => {
  let fs: InMemoryFs;
  let ctx: any;

  beforeEach(() => {
    fs = new InMemoryFs({
      "data.txt": "some data",
    });
    ctx = {
      fs,
      cwd: "/",
      state: {
        env: new Map([["USER", "tester"]]),
        functions: new Map(),
      },
      stdin: "",
    };
  });

  it("should create a snapshot file", async () => {
    const result = await agSnapshotCommand.execute(["create", "snap1"], ctx);
    expect(result.exitCode).toBe(0);
    expect(await fs.exists("/.ag-snapshots/snap1.json")).toBe(true);
  });

  it("should restore environment from a snapshot", async () => {
    await agSnapshotCommand.execute(["create", "snap2"], ctx);
    
    // Change state
    ctx.state.env.set("USER", "intruder");
    ctx.state.env.set("NEWVAR", "val");
    
    const result = await agSnapshotCommand.execute(["restore", "snap2"], ctx);
    expect(result.exitCode).toBe(0);
    expect(ctx.state.env.get("USER")).toBe("tester");
    expect(ctx.state.env.has("NEWVAR")).toBe(false);
  });

  it("should return error if snapshot not found", async () => {
    const result = await agSnapshotCommand.execute(["restore", "ghost"], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });
});
