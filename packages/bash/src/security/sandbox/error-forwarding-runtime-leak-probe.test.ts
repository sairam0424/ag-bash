import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import { MountableFs } from "../../fs/mountable-fs/mountable-fs.js";
import { ReadWriteFs } from "../../fs/read-write-fs/read-write-fs.js";

/**
 * Runtime error-forwarding leak probes.
 *
 * When `ln` / `python3` / `sqlite3` hit a directory-operation error against a
 * host-backed sandbox filesystem, the error surfaced to the user MUST NOT leak
 * any host/internal path markers (real host root, /Users, node:internal,
 * file:// URLs). The only path that may appear is the *virtual* sandbox path
 * the user typed.
 *
 * A `ReadWriteFs` is host-backed but is pure-async: it has no synchronous
 * `mkdirSync`/`writeFileSync`, so it cannot be used as the MountableFs *base*
 * (filesystem init needs sync mkdir to create /bin, /dev, /proc and would throw
 * at construction). The supported way to expose a host directory through a
 * ReadWriteFs is to MOUNT it at a subpath over an InMemoryFs base — this is the
 * canonical pattern documented on MountableFs and the construction these probes
 * use so the real host-backed error path (and its sanitizer) is exercised.
 */
describe("runtime error-forwarding leak probes", () => {
  let tempDir: string;
  // The host root the ReadWriteFs is mounted on. Must never appear in stderr.
  let canonicalRoot: string;

  const MOUNT = "/work";

  function makeBash(): Bash {
    const base = new InMemoryFs();
    const mountable = new MountableFs({ base });
    mountable.mount(
      MOUNT,
      new ReadWriteFs({ root: tempDir, allowSymlinks: true }),
    );
    return new Bash({ fs: mountable, cwd: "/", runtimes: { python: true } });
  }

  // Assert the no-leak security invariant: no host/internal markers, and the
  // host root (in either raw or symlink-canonical form) never appears.
  function assertNoHostLeak(stderr: string): void {
    expect(stderr).not.toContain(tempDir);
    expect(stderr).not.toContain(canonicalRoot);
    expect(stderr).not.toContain("/Users/");
    expect(stderr).not.toContain("/private/");
    expect(stderr).not.toContain("node:internal");
    expect(stderr).not.toContain("file://");
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jb-runtime-leak-"));
    // Resolve symlinks (e.g. macOS /var -> /private/var) so we can assert the
    // canonical host root never leaks either.
    canonicalRoot = fs.realpathSync(tempDir);
    fs.mkdirSync(path.join(tempDir, "dir"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "pkg"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "dbdir"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "target.txt"), "ok\n");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("ln hard-link directory failure does not expose host/internal markers", async () => {
    const bash = makeBash();

    const result = await bash.exec(`ln ${MOUNT}/dir ${MOUNT}/dirlink`);

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `ln: '${MOUNT}/dir': hard link not allowed for directory\n`,
    );
    expect(result.exitCode).toBe(1);
    assertNoHostLeak(result.stderr);
  });

  it("python3 script-open directory error does not expose host/internal markers", async () => {
    const bash = makeBash();

    const result = await bash.exec(`python3 ${MOUNT}/pkg`);

    expect(result.stdout).toBe("");
    // The errno detail carries only the sandbox-relative path ('/pkg'), which
    // ReadWriteFs re-throws in place of the host path — never the host root.
    expect(result.stderr).toBe(
      `python3: can't open file '${MOUNT}/pkg': EISDIR: illegal operation on a directory, read '/pkg'\n`,
    );
    expect(result.exitCode).toBe(2);
    assertNoHostLeak(result.stderr);
  });

  it("sqlite3 open-directory error does not expose host/internal markers", async () => {
    const bash = makeBash();

    const result = await bash.exec(`sqlite3 ${MOUNT}/dbdir 'select 1;'`);

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `sqlite3: unable to open database "${MOUNT}/dbdir": EISDIR: illegal operation on a directory, read '/dbdir'\n`,
    );
    expect(result.exitCode).toBe(1);
    assertNoHostLeak(result.stderr);
  });
});
