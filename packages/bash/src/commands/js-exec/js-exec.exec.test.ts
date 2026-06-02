import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("js-exec child_process sub-shell", () => {
  it("should execute a shell command and return result", {
    timeout: 30000,
  }, async () => {
    const env = new Bash({ runtimes: { javascript: true } });
    const result = await env.exec(
      `js-exec -c "const cp = require('child_process'); console.log(cp.execSync('echo hello').trim())"`,
    );
    expect(result.stdout).toBe("hello\n");
    expect(result.exitCode).toBe(0);
  });

  it("should return exit code from sub-shell via spawnSync", async () => {
    const env = new Bash({ runtimes: { javascript: true } });
    const result = await env.exec(
      `js-exec -c "const cp = require('child_process'); const r = cp.spawnSync('false'); console.log(r.status)"`,
    );
    expect(result.stdout).toBe("1\n");
    expect(result.exitCode).toBe(0);
  });

  it("should capture stderr from sub-shell", async () => {
    const env = new Bash({ runtimes: { javascript: true } });
    const result = await env.exec(
      `js-exec -c "const cp = require('child_process'); const r = cp.spawnSync('echo', ['error', '>&2']); console.log(typeof r.stderr)"`,
    );
    expect(result.stdout).toBe("string\n");
    expect(result.exitCode).toBe(0);
  });

  it("should throw from execSync on failure", async () => {
    const env = new Bash({ runtimes: { javascript: true } });
    const result = await env.exec(
      `js-exec -c "const cp = require('child_process'); try { cp.execSync('false'); } catch(e) { console.log('caught:', e.status); }"`,
    );
    expect(result.stdout).toBe("caught: 1\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle multi-command pipelines", async () => {
    const env = new Bash({ runtimes: { javascript: true } });
    const result = await env.exec(
      `js-exec -c "const cp = require('child_process'); console.log(cp.execSync('echo abc | tr a-z A-Z').trim())"`,
    );
    expect(result.stdout).toBe("ABC\n");
    expect(result.exitCode).toBe(0);
  });

  it("should forward a single spawnSync arg (regression #49)", async () => {
    const env = new Bash({
      runtimes: { javascript: true },
      files: {
        "/home/user/single.js": `const cp = require('child_process');
const r = cp.spawnSync('echo', ['hi'], { encoding: 'utf8' });
console.log('OUT[' + r.stdout.trim() + ']STATUS[' + r.status + ']');
`,
      },
    });
    const result = await env.exec("js-exec /home/user/single.js");
    // Before the fix the args were dropped: stdout was '\n' -> 'OUT[]STATUS[0]'.
    expect(result.stdout).toBe("OUT[hi]STATUS[0]\n");
    expect(result.exitCode).toBe(0);
  });

  it("should forward multiple spawnSync args verbatim (regression #49)", async () => {
    const env = new Bash({
      runtimes: { javascript: true },
      files: {
        "/home/user/multi.js": `const cp = require('child_process');
const r = cp.spawnSync('echo', ['a', 'b', 'c'], { encoding: 'utf8' });
console.log('OUT[' + r.stdout.trim() + ']');
`,
      },
    });
    const result = await env.exec("js-exec /home/user/multi.js");
    expect(result.stdout).toBe("OUT[a b c]\n");
    expect(result.exitCode).toBe(0);
  });

  it("should treat shell metacharacters in spawnSync args as literals (injection-safe)", async () => {
    const env = new Bash({
      runtimes: { javascript: true },
      files: {
        "/home/user/inject.js": `const cp = require('child_process');
const r = cp.spawnSync('echo', ['; rm -rf x', '$HOME', '*', '\\\`id\\\`'], { encoding: 'utf8' });
console.log('OUT[' + r.stdout.trim() + ']');
`,
      },
    });
    const result = await env.exec("js-exec /home/user/inject.js");
    // spawnSync args are NOT shell-reparsed: no command-split (;), no variable
    // expansion ($HOME), no glob (*), no command substitution (backticks).
    expect(result.stdout).toBe("OUT[; rm -rf x $HOME * `id`]\n");
    expect(result.exitCode).toBe(0);
  });

  it("must NOT execute an injected command embedded in a spawnSync arg", async () => {
    const env = new Bash({
      runtimes: { javascript: true },
      files: {
        "/home/user/inject-file.js": `const cp = require('child_process');
cp.spawnSync('echo', ['; touch /home/user/PWNED ;'], { encoding: 'utf8' });
const fs = require('fs');
console.log('PWNED_EXISTS[' + fs.existsSync('/home/user/PWNED') + ']');
`,
      },
    });
    const result = await env.exec("js-exec /home/user/inject-file.js");
    // The ';'-delimited payload is a literal argv token for `echo`, never a
    // second command — so the `touch` never runs and the file is not created.
    expect(result.stdout).toBe("PWNED_EXISTS[false]\n");
    expect(result.exitCode).toBe(0);
  });

  it("should block recursive js-exec invocation", {
    timeout: 30000,
  }, async () => {
    const env = new Bash({
      runtimes: { javascript: true },
      files: {
        "/home/user/reentrant.js": `const cp = require('child_process');
const r = cp.spawnSync('js-exec', ['-c', '1+1']);
console.log(r.stderr.trim());
`,
      },
    });
    const result = await env.exec("js-exec /home/user/reentrant.js");
    expect(result.stdout).toContain("recursive invocation is not supported");
    expect(result.exitCode).toBe(0);
  });
});
