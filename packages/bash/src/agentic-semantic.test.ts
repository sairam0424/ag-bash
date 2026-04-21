import { describe, it, expect } from "vitest";
import { Bash } from "./Bash.js";

describe("Agentic Healer - Semantic Integration", () => {
  it("should suggest similar function names for command not found", async () => {
    const bash = new Bash({
      agentic: true,
      parserEngine: "legacy",
    });

    const script = `
      function hello_world() {
        echo "hello"
      }
      hello_word
    `;

    const result = await bash.exec(script);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Did you mean function 'hello_world'?");
  });

  it("should suggest similar variable names for nounset error", async () => {
    const bash = new Bash({
      agentic: true,
      parserEngine: "legacy",
    });

    const script = `
      set -u
      MY_LONG_VARIABLE="value"
      echo $MY_LONG_VARIBALE
    `;

    const result = await bash.exec(script);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Did you mean 'MY_LONG_VARIABLE'?");
  });

  it("should suggest builtin commands for typos", async () => {
     const bash = new Bash({
      agentic: true,
      parserEngine: "legacy",
    });

    const result = await bash.exec("echho hello");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Did you mean builtin 'echo'?");
  });
});
