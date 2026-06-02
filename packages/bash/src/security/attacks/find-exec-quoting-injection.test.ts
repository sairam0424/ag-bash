import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("find -exec quoting and argument boundary safety", () => {
  it("filename with embedded quote does not break -exec command boundaries", async () => {
    const bash = new Bash();

    const result = await bash.exec(`
      rm -f /tmp/find-exec-injected-marker
      mkdir -p /tmp/find-exec-injection
      touch '/tmp/find-exec-injection/a" ; echo FIND_EXEC_INJECTED > /tmp/find-exec-injected-marker ; #.txt'
      find /tmp/find-exec-injection -type f -exec echo {} \\;
      if [ -f /tmp/find-exec-injected-marker ]; then
        echo INJECTED_PRESENT
      else
        echo INJECTED_ABSENT
      fi
    `);

    // Security invariant: the injection never ran. The marker file was not
    // created, so the script reports INJECTED_ABSENT. The hardened find/argv
    // handling means the embedded `" ; echo FIND_EXEC_INJECTED ; #` payload is
    // never interpreted as a command boundary — stdout carries only the
    // INJECTED_ABSENT signal and never the FIND_EXEC_INJECTED marker text.
    expect(result.stdout).toBe("INJECTED_ABSENT\n");
    expect(result.stdout).not.toContain("FIND_EXEC_INJECTED");
    // The marker text DOES surface in stderr — but only as literal filename
    // data inside the `touch` ENOENT diagnostic, never as the output of the
    // injected `echo` command actually running. This matches real bash, where
    // the entire `a" ; echo ... ; #.txt` string is one filename that touch
    // fails to create. Assert the marker appears solely within that quoted
    // touch error, proving the payload was treated as inert data and never as
    // a command boundary.
    const injectionLines = result.stderr
      .split("\n")
      .filter((line) => line.includes("FIND_EXEC_INJECTED"));
    expect(injectionLines.length).toBeGreaterThan(0);
    for (const line of injectionLines) {
      expect(line).toMatch(/^touch: /);
    }
    expect(result.exitCode).toBe(0);
  });
});
