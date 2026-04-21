import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";

describe("Bash Snapshot/Restore", () => {
  it("should capture and restore environment variables", async () => {
    const bash = new Bash();
    
    // 1. Set a variable
    await bash.exec("export FOO=initial", { persistState: true });
    expect((await bash.exec("echo $FOO")).stdout).toBe("initial\n");

    // 2. Take snapshot
    const snapshot = await bash.snapshot();

    // 3. Change variable
    await bash.exec("export FOO=changed", { persistState: true });
    expect((await bash.exec("echo $FOO")).stdout).toBe("changed\n");

    // 4. Restore snapshot
    await bash.restore(snapshot);
    expect((await bash.exec("echo $FOO")).stdout).toBe("initial\n");
  });

  it("should capture and restore filesystem changes", async () => {
    const bash = new Bash();
    
    // 1. Create a file
    await bash.exec("echo 'hello' > /test.txt");
    expect(await bash.readFile("/test.txt")).toBe("hello\n");

    // 2. Take snapshot
    const snapshot = await bash.snapshot();

    // 3. Delete/Modify file
    await bash.exec("rm /test.txt");
    await expect(bash.readFile("/test.txt")).rejects.toThrow();

    // 4. Restore snapshot
    await bash.restore(snapshot);
    expect(await bash.readFile("/test.txt")).toBe("hello\n");
  });

  it("should capture and restore current working directory", async () => {
    const bash = new Bash();
    
    // 1. Change directory
    await bash.exec("mkdir /work; cd /work", { persistState: true });
    expect(bash.getCwd()).toBe("/work");

    // 2. Take snapshot
    const snapshot = await bash.snapshot();

    // 3. Change directory again
    await bash.exec("cd /", { persistState: true });
    expect(bash.getCwd()).toBe("/");

    // 4. Restore snapshot
    await bash.restore(snapshot);
    expect(bash.getCwd()).toBe("/work");
  });

  it("should capture and restore function definitions", async () => {
    const bash = new Bash();
    
    // 1. Define a function
    await bash.exec("hello() { echo 'hi'; }", { persistState: true });
    expect((await bash.exec("hello")).stdout).toBe("hi\n");

    // 2. Take snapshot
    const snapshot = await bash.snapshot();

    // 3. Redefine or unset function
    await bash.exec("hello() { echo 'bye'; }", { persistState: true });
    expect((await bash.exec("hello")).stdout).toBe("bye\n");

    // 4. Restore snapshot
    await bash.restore(snapshot);
    expect((await bash.exec("hello")).stdout).toBe("hi\n");
  });

  it("should handle nested snapshots and independent rollbacks", async () => {
    const bash = new Bash();
    
    await bash.exec("export STEP=0", { persistState: true });
    const snap0 = await bash.snapshot();

    await bash.exec("export STEP=1", { persistState: true });
    const snap1 = await bash.snapshot();

    await bash.exec("export STEP=2", { persistState: true });
    expect((await bash.exec("echo $STEP")).stdout).toBe("2\n");

    await bash.restore(snap1);
    expect((await bash.exec("echo $STEP")).stdout).toBe("1\n");

    await bash.restore(snap0);
    expect((await bash.exec("echo $STEP")).stdout).toBe("0\n");
  });
});
