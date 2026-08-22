/**
 * U12 — ag-convert host-path read: exploitability probe.
 *
 * `ag-convert` resolves the user-supplied file against the VFS, then tries to
 * translate the virtual path to a real host path via `ctx.fs.toRealPath()`.
 * The default filesystem is `MountableFs` over `InMemoryFs`; `MountableFs`
 * always exposes `toRealPath`, but it delegates to the base filesystem, and
 * `InMemoryFs` does not implement it — so the call returns `null` and
 * `ag-convert` falls back to `realFilePath = virtualPath`. The existence
 * pre-check (`ctx.fs.exists`) is then performed against the VFS, while the
 * string that is actually handed to `spawnSync("python3", …)` is interpreted
 * by the HOST filesystem.
 *
 * These tests decide empirically whether that gap leaks host file content into
 * the sandbox's stdout. The safe expectation is asserted: host content must
 * never reach stdout. If the exploit test fails, the read is live.
 *
 * False-negative guard: the host conversion chain (python3 + markitdown) is
 * probed at collection time. When it is unavailable the spawn-dependent tests
 * are skipped rather than passed, so "nothing executed" can never be mistaken
 * for "a control blocked it".
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

/** Canary that only ever exists in the real host file. */
const HOST_CANARY = "AG_CONVERT_U12_HOST_CANARY_4f19a7";
/** Canary that only ever exists in the in-VFS decoy at the same path. */
const VFS_CANARY = "AG_CONVERT_U12_VFS_DECOY_b83c25";

const bridgePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "hyperion_bridge.py",
);

/**
 * Is the host conversion chain actually able to read a file? Probed once, at
 * module scope, so the result is known when tests are collected.
 */
const hostChainLive = (() => {
  const probe = spawnSync("python3", ["-c", "import markitdown"], {
    encoding: "utf-8",
  });
  return !probe.error && probe.status === 0;
})();

describe("ag-convert host-path read (U12)", () => {
  let hostDir = "";
  let hostFile = "";

  beforeAll(() => {
    hostDir = mkdtempSync(join(tmpdir(), "ag-convert-u12-"));
    hostFile = join(hostDir, "u12-probe.txt");
    writeFileSync(hostFile, `${HOST_CANARY}\nsecond host line\n`, "utf-8");
  });

  afterAll(() => {
    if (hostDir) {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  /**
   * Host-independent: documents the premise. The default VFS cannot translate
   * a virtual path to a host path, so ag-convert keeps the virtual path.
   */
  it("default VFS toRealPath() returns null, so ag-convert forwards the raw virtual path", () => {
    const bash = new Bash();
    expect(typeof bash.fs.toRealPath).toBe("function");
    expect(bash.fs.toRealPath("/var/tmp/u12-not-mounted.txt")).toBeNull();
  });

  /**
   * Control: proves the spawn chain is live on this host. If this is skipped,
   * the exploit test below is inconclusive rather than reassuring.
   */
  it.runIf(hostChainLive)(
    "control: the hyperion bridge itself reads the host file (chain is live)",
    () => {
      const direct = spawnSync("python3", [bridgePath, hostFile], {
        encoding: "utf-8",
      });
      expect(direct.error).toBeUndefined();
      expect(direct.status).toBe(0);
      expect(direct.stdout).toContain(HOST_CANARY);
    },
    60_000,
  );

  /**
   * The actual question. A path that exists ONLY in the in-memory VFS (with
   * decoy content) but also names a real host file must not cause the host
   * file to be read.
   */
  it.runIf(hostChainLive)(
    "must not leak host file content for a path that exists in the VFS",
    async () => {
      const bash = new Bash();
      await bash.exec(`mkdir -p ${hostDir}`);
      await bash.exec(`printf '%s\\n' '${VFS_CANARY}' > ${hostFile}`);

      // The decoy really is what the sandbox sees.
      const seen = await bash.exec(`cat ${hostFile}`);
      expect(seen.stdout).toContain(VFS_CANARY);
      expect(seen.stdout).not.toContain(HOST_CANARY);

      const result = await bash.exec(`ag-convert ${hostFile}`);

      expect(result.stdout).not.toContain(HOST_CANARY);
      expect(result.stderr).not.toContain(HOST_CANARY);
    },
    60_000,
  );

  /**
   * `--analyze` needs no converter dependency at all (it only stats the file),
   * so it is a separate, cheaper oracle for the same gap: host size/existence
   * must not be reported for a VFS-only path.
   */
  it("must not leak host file metadata via --analyze for a path that exists in the VFS", async () => {
    const bash = new Bash();
    await bash.exec(`mkdir -p ${hostDir}`);
    await bash.exec(`printf '%s\\n' '${VFS_CANARY}' > ${hostFile}`);

    const result = await bash.exec(`ag-convert ${hostFile} --analyze`);

    // A host stat would report the real file's size (~40 bytes → 0.0 MB) and
    // succeed; the safe outcome is that the host file is never stat'd.
    expect(result.stdout).not.toContain('"recommended_engine"');
  }, 60_000);
});
