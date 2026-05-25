import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("trap execution", () => {
  describe("EXIT trap", () => {
    it("should fire EXIT trap on normal script completion", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap 'echo EXITING' EXIT
        echo hello
      `);
      expect(result.stdout).toBe("hello\nEXITING\n");
      expect(result.exitCode).toBe(0);
    });

    it("should fire EXIT trap when exit is called", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap 'echo GOODBYE' EXIT
        echo before
        exit 0
        echo after
      `);
      expect(result.stdout).toBe("before\nGOODBYE\n");
      expect(result.exitCode).toBe(0);
    });

    it("should fire EXIT trap with non-zero exit code", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap 'echo TRAP_FIRED' EXIT
        exit 42
      `);
      expect(result.stdout).toContain("TRAP_FIRED\n");
      expect(result.exitCode).toBe(42);
    });

    it("should fire EXIT trap with multi-command handler", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap 'echo first; echo second' EXIT
        echo main
      `);
      expect(result.stdout).toBe("main\nfirst\nsecond\n");
    });
  });

  describe("ERR trap", () => {
    it("should fire ERR trap on command failure", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap 'echo ERROR_CAUGHT' ERR
        false
        echo after
      `);
      expect(result.stdout).toContain("ERROR_CAUGHT\n");
      expect(result.stdout).toContain("after\n");
    });

    it("should NOT fire ERR trap in condition context (if)", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap 'echo ERR_FIRED' ERR
        if false; then
          echo yes
        fi
        echo done
      `);
      // ERR trap should NOT fire for the 'false' in the if condition
      expect(result.stdout).toBe("done\n");
    });

    it("should NOT fire ERR trap for negated pipeline", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap 'echo ERR_FIRED' ERR
        ! true
        echo done
      `);
      // `! true` is a negated pipeline so ERR should not fire
      expect(result.stdout).not.toContain("ERR_FIRED");
    });

    it("should NOT fire ERR trap in && chain short-circuit", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap 'echo ERR_FIRED' ERR
        false && true
        echo done
      `);
      // Short-circuited commands do not trigger ERR
      expect(result.stdout).not.toContain("ERR_FIRED");
    });

    it("should not cause infinite recursion if ERR handler itself fails", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap 'false' ERR
        false
        echo survived
      `);
      // The ERR handler calls 'false' which fails, but should not re-trigger ERR
      expect(result.stdout).toContain("survived\n");
    });
  });

  describe("RETURN trap", () => {
    it("should fire RETURN trap after function returns normally", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap 'echo RETURNED' RETURN
        myfunc() {
          echo "in func"
        }
        myfunc
        echo done
      `);
      expect(result.stdout).toContain("in func\n");
      expect(result.stdout).toContain("RETURNED\n");
    });

    it("should fire RETURN trap after explicit return", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap 'echo RETURN_TRAP' RETURN
        myfunc() {
          echo before
          return 0
          echo after
        }
        myfunc
        echo done
      `);
      expect(result.stdout).toContain("before\n");
      expect(result.stdout).toContain("RETURN_TRAP\n");
      expect(result.stdout).not.toContain("after\n");
    });
  });

  describe("empty trap handler (ignore)", () => {
    it("should treat empty handler as no-op for ERR", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap '' ERR
        false
        echo "still running"
      `);
      expect(result.stdout).toBe("still running\n");
      expect(result.exitCode).toBe(0);
    });

    it("should treat empty handler as no-op for EXIT", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap '' EXIT
        echo hello
      `);
      expect(result.stdout).toBe("hello\n");
    });
  });

  describe("trap handler can access shell variables", () => {
    it("should access variables defined in the script", async () => {
      const env = new Bash();
      const result = await env.exec(`
        MY_VAR="world"
        trap 'echo "hello $MY_VAR"' EXIT
        MY_VAR="universe"
      `);
      // Trap executes at exit time, so it should see the latest value
      expect(result.stdout).toBe("hello universe\n");
    });
  });

  describe("trap removal", () => {
    it("should not fire trap after it is removed with trap - SIGNAL", async () => {
      const env = new Bash();
      const result = await env.exec(`
        trap 'echo TRAPPED' EXIT
        trap - EXIT
        echo done
      `);
      expect(result.stdout).toBe("done\n");
      expect(result.stdout).not.toContain("TRAPPED");
    });
  });
});
