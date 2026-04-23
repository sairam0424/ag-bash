import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";

describe("Agentic Healer", () => {
  it("should provide heuristic suggestions for missing files", async () => {
    const bash = new Bash({
      agentic: true,
      agenticConfig: { enableHeuristics: true },
      parserEngine: "legacy",
    });

    const result = await bash.exec("cat non-existent-file.txt");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("[Agentic Healer]");
    expect(result.stderr).toContain("was not found");
  });

  it("should provide suggestions for common typos", async () => {
    const bash = new Bash({
      agentic: true,
      parserEngine: "legacy",
    });

    const result = await bash.exec("git stauts");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Did you mean 'git status'?");
  });

  it("should use LLM provider if configured", async () => {
    const mockLLM = {
      generateSuggestion: async (context: string) => {
        if (context.includes("failed-cmd")) {
          return "Mock LLM Suggestion";
        }
        return null;
      },
    };

    const bash = new Bash({
      agentic: true,
      agenticConfig: {
        enableHeuristics: false,
        llm: mockLLM,
      },
      parserEngine: "legacy",
    });

    const result = await bash.exec("failed-cmd");
    expect(result.stderr).toContain("[Agentic Healer] Mock LLM Suggestion");
  });

  it("should not provide suggestions when agentic is false", async () => {
    const bash = new Bash({
      agentic: false,
      parserEngine: "legacy",
    });

    const result = await bash.exec("cat non-existent.txt");
    expect(result.stderr).not.toContain("[Agentic Healer]");
  });
});
