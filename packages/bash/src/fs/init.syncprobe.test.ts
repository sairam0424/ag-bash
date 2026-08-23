import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "./in-memory-fs/in-memory-fs.js";
import { MountableFs } from "./mountable-fs/mountable-fs.js";
import { ReadWriteFs } from "./read-write-fs/read-write-fs.js";

/**
 * `initFilesystem()` gates the synchronous scaffolding of /bin, /usr/bin, /tmp,
 * /home/user, /dev/* and /proc/* behind a duck-type probe. `Bash` always wraps
 * a supplied `fs` in `MountableFs`, so the probe used to inspect the WRAPPER
 * (which always has mkdirSync/writeFileSync) instead of the effective BASE
 * (which may be pure-async). With a pure-async base the probe said "sync init
 * is fine", init proceeded, and construction died with
 * `mkdirSync not supported on filesystem at '/bin'` — a message that blames
 * /bin for what is really a topology problem.
 *
 * These tests pin the intended behaviour:
 *   1. the probe interrogates the effective base, and
 *   2. an unsupported base fails EARLY with an actionable message that names
 *      the base and the supported topology,
 * while the default sync-base path (every existing user) is untouched.
 */
describe("initFilesystem sync-capability probe", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ag-bash-syncprobe-"));
    await writeFile(join(tempDir, "host.txt"), "from-host\n", "utf8");
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("pure-async base (unsupported topology)", () => {
    it("fails at construction with an actionable message, not a /bin message", () => {
      const hostFs = new ReadWriteFs({ root: tempDir });

      let thrown: unknown;
      try {
        new Bash({ fs: hostFs });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : String(thrown);

      // Names the actual culprit: the base filesystem class.
      expect(message).toContain("ReadWriteFs");
      // Points at the supported topology instead of a random path.
      expect(message).toContain("mount");
      expect(message).toMatch(/InMemoryFs|OverlayFs/);
      // The old, misleading failure mode must be gone.
      expect(message).not.toContain("mkdirSync not supported on filesystem");
      expect(message).not.toContain("'/bin'");
    });

    it("reports the base as sync-incapable via MountableFs.inspectSyncInitSupport()", () => {
      const fs = new MountableFs({ base: new ReadWriteFs({ root: tempDir }) });

      expect(fs.inspectSyncInitSupport()).toEqual({
        supported: false,
        baseName: "ReadWriteFs",
      });
    });

    it("unwraps a nested MountableFs when resolving the effective base", () => {
      const inner = new MountableFs({
        base: new ReadWriteFs({ root: tempDir }),
      });
      const outer = new MountableFs({ base: inner });

      expect(outer.inspectSyncInitSupport()).toEqual({
        supported: false,
        baseName: "ReadWriteFs",
      });
    });
  });

  describe("sync base (the default for every existing user)", () => {
    it("still scaffolds the standard layout on the implicit InMemoryFs base", async () => {
      const bash = new Bash();
      try {
        for (const dir of ["/bin", "/usr/bin", "/tmp", "/home/user"]) {
          expect(await bash.fs.exists(dir)).toBe(true);
        }
        for (const file of [
          "/dev/null",
          "/dev/zero",
          "/proc/version",
          "/proc/self/status",
          "/proc/self/fd/0",
        ]) {
          expect(await bash.fs.exists(file)).toBe(true);
        }
        expect(await bash.fs.readFile("/proc/self/exe")).toBe("/bin/bash");
      } finally {
        await bash[Symbol.asyncDispose]();
      }
    });

    it("reports the base as sync-capable via MountableFs.inspectSyncInitSupport()", () => {
      expect(
        new MountableFs({ base: new InMemoryFs() }).inspectSyncInitSupport(),
      ).toEqual({ supported: true, baseName: "InMemoryFs" });
      expect(new MountableFs().inspectSyncInitSupport()).toEqual({
        supported: true,
        baseName: "InMemoryFs",
      });
    });

    it("scaffolds when a host-backed ReadWriteFs is MOUNTED over a sync base", async () => {
      const hostFs = new ReadWriteFs({ root: tempDir });
      const bash = new Bash({
        fs: new MountableFs({
          base: new InMemoryFs(),
          mounts: [{ mountPoint: "/work", filesystem: hostFs }],
        }),
      });
      try {
        expect(await bash.fs.exists("/bin")).toBe(true);
        expect(await bash.fs.exists("/dev/null")).toBe(true);
        expect(await bash.fs.readFile("/work/host.txt")).toBe("from-host\n");

        // toRealPath() semantics are load-bearing for ag-convert's fail-closed
        // host-file gate: VFS-only paths MUST stay null, mounted host paths
        // MUST resolve. Guard both here so this change cannot regress them.
        expect(bash.fs.toRealPath("/tmp/vfs-only")).toBeNull();
        expect(bash.fs.toRealPath("/bin")).toBeNull();
        expect(bash.fs.toRealPath("/work/host.txt")).toContain("host.txt");
      } finally {
        await bash[Symbol.asyncDispose]();
      }
    });
  });
});
