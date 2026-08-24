/**
 * ag_lsp declares a zod `parameters` schema. It must actually be enforced.
 *
 * An explicit `validateInput: async () => ({ result: true })` stub suppresses
 * the buildTool safeParse gate and hands unvalidated, model-controlled input
 * straight to execute — the same anti-pattern that was removed from
 * ag_web_search, where it had enabled a shell-injection vector (see the
 * warning comments in commands/ag-web/ag-web-search.ts:48 and
 * ag-web-fetch.ts:40).
 *
 * PATH CHOICE: every probe below uses a `.py` path, never `.ts`/`.js`.
 * Bash.ts:511 fires `initLsp()` (unawaited), which registers LSPConnections
 * for the "ts" and "js" extensions against `typescript-language-server`. When
 * that binary is absent the spawn fails ENOENT, yet LSPManager.sendRequest
 * still finds a connection, and LSPConnection.sendRequest (LSPConnection.ts:45)
 * returns a Promise it never settles — no timeout, no reject on process
 * error/exit. So `ag_lsp` on any .ts/.js file hangs FOREVER. That is a
 * pre-existing defect in LSPConnection/LSPManager, outside this file set and
 * reported separately; `.py` takes the semantic-engine fallback instead and
 * keeps these assertions about validation rather than about the hang.
 */
import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { LspTool } from "./LspTool.js";

async function callLsp(args: Record<string, unknown>): Promise<string> {
  const bash = new Bash();
  return String(await bash.toolbox.callTool(bash, "ag_lsp", args));
}

describe("ag_lsp input validation", () => {
  it("rejects a missing filePath", async () => {
    expect(await callLsp({ operation: "hover" })).toContain("Validation Error");
  });

  it("rejects a non-string filePath instead of throwing inside execute", async () => {
    // LSPManager.sendRequest does request.filePath.split("."), so a number
    // here reaches a TypeError rather than a validation rejection.
    const result = await callLsp({ operation: "hover", filePath: 5 });
    expect(result).toContain("Validation Error");
    expect(result).not.toContain("LSP Error");
  });

  it("rejects an operation outside the declared enum", async () => {
    expect(
      await callLsp({ operation: "textDocument/rename", filePath: "/a.py" }),
    ).toContain("Validation Error");
  });

  it("rejects a non-numeric line", async () => {
    expect(
      await callLsp({ operation: "hover", filePath: "/a.py", line: "3" }),
    ).toContain("Validation Error");
  });

  it("accepts a well-formed request (validation is not blanket-deny)", async () => {
    const result = await callLsp({
      operation: "hover",
      filePath: "/a.py",
      line: 1,
      character: 1,
    });
    expect(result).not.toContain("Validation Error");
    expect(result).toBe("No information found.");
  });
});

describe("ag_lsp permissions", () => {
  it("does not hardcode an allow — the read-only default gate decides", async () => {
    // ag_lsp is isReadOnly/non-destructive today, so the default gate allows
    // it even in plan mode. Asserting through the gate (rather than accepting a
    // literal `allow`) means the day someone gives ag_lsp a write, plan mode
    // covers it automatically instead of silently not applying.
    const bash = new Bash();
    await bash.exec("ag-plan enter");
    const decision = await LspTool.checkPermissions(bash, {
      operation: "hover",
      filePath: "/a.py",
    });
    expect(decision.behavior).toBe("allow");
    expect(LspTool.isDestructive).toBe(false);
  });
});
