import { describe, it, expect, beforeEach } from "vitest";
import { Bash } from "./Bash.js";
import { InMemoryFs } from "./fs/in-memory-fs/index.js";

describe("State Management (Phase 7)", () => {
  let bash: Bash;

  beforeEach(() => {
    bash = new Bash({
      parserEngine: 'legacy',
      fs: new InMemoryFs({
        "/file1.txt": "initial",
      }),
      env: { VAR1: "initial" },
    });
  });

  it("should save and restore a snapshot", async () => {
    // Save initial state
    await bash.saveSnapshot("base");

    // Modify state
    await bash.fs.writeFile("/file1.txt", "modified");
    await bash.fs.writeFile("/file2.txt", "new");
    await bash.exec("export VAR1=modified");
    await bash.exec("export VAR2=new");
    await bash.exec("cd /");

    // Verify modifications
    expect(await bash.fs.readFile("/file1.txt")).toBe("modified");
    expect(await bash.fs.exists("/file2.txt")).toBe(true);

    // Restore
    await bash.restoreSnapshot("base");

    // Verify restoration
    expect(await bash.fs.readFile("/file1.txt")).toBe("initial");
    expect(await bash.fs.exists("/file2.txt")).toBe(false);
    
    // Check env restoration
    const res = await bash.exec("echo $VAR1; echo $VAR2");
    expect(res.stdout).toBe("initial\n\n");
  });

  it("should throw error for non-existent snapshot", async () => {
    await expect(bash.restoreSnapshot("ghost")).rejects.toThrow("Snapshot 'ghost' not found");
  });

  it("should handle multiple snapshots", async () => {
    await bash.saveSnapshot("s1");
    await bash.fs.writeFile("/s1.txt", "s1");
    
    await bash.saveSnapshot("s2");
    await bash.fs.writeFile("/s2.txt", "s2");

    await bash.restoreSnapshot("s1");
    expect(await bash.fs.exists("/s1.txt")).toBe(false);
    expect(await bash.fs.exists("/s2.txt")).toBe(false);

    await bash.restoreSnapshot("s2");
    expect(await bash.fs.exists("/s1.txt")).toBe(true);
    expect(await bash.fs.exists("/s2.txt")).toBe(false);
  });
});
