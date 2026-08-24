import { z } from "zod";
import { buildTool, type ToolboxTool } from "../agentic/Tool.js";
import type { Bash } from "../Bash.js";

/**
 * ag_lsp: Unified tool for code intelligence.
 *
 * Built through `buildTool` so the Tool.ts defaults apply:
 *  - `validateInput` -> `parameters.safeParse`. An explicit
 *    `async () => ({ result: true })` stub used to sit here and suppressed it,
 *    handing unvalidated model-controlled input straight to execute (a missing
 *    or non-string `filePath` reached `filePath.split(".")` in
 *    LSPManager.sendRequest, and `operation` was not held to its enum). This is
 *    the same anti-pattern already removed from ag_web_search, where it had
 *    enabled shell injection — see the warning comments in
 *    commands/ag-web/ag-web-search.ts and ag-web-fetch.ts.
 *  - `checkPermissions` -> the plan-mode gate keyed on `isDestructive`. This
 *    tool is read-only, so the gate allows it exactly as the old hardcoded
 *    `{ behavior: "allow" }` did; deferring to the gate means the day ag_lsp
 *    gains a write (applyEdit / rename / code actions are the obvious next
 *    operations), plan mode covers it instead of silently not applying.
 * Do not re-add either override.
 */
export const LspTool: ToolboxTool = buildTool<any, any>({
  name: "ag_lsp",
  description:
    "Advanced code intelligence: goToDefinition, findReferences, hover, etc.",
  parameters: z.object({
    operation: z
      .enum([
        "goToDefinition",
        "typeDefinition",
        "implementation",
        "findReferences",
        "hover",
        "documentSymbol",
        "workspaceSymbol",
        "diagnostics",
      ])
      .describe("The LSP operation to perform."),
    filePath: z.string().describe("Path to the file."),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based line number."),
    character: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based character position."),
    symbolName: z
      .string()
      .optional()
      .describe("Name of the symbol (optional if position is provided)."),
  }),
  isReadOnly: true,
  isDestructive: false,
  execute: async (bash: Bash, args: any) => {
    const manager = bash.services.lspManager;

    // Map operation names to LSP methods
    const methodMap: Record<string, string> = Object.assign(
      Object.create(null),
      {
        goToDefinition: "textDocument/definition",
        typeDefinition: "textDocument/typeDefinition",
        implementation: "textDocument/implementation",
        findReferences: "textDocument/references",
        hover: "textDocument/hover",
        documentSymbol: "textDocument/documentSymbol",
        workspaceSymbol: "workspace/symbol",
        diagnostics: "textDocument/publishDiagnostics", // Note: This is usually a notification, but we might simulate a poll
      },
    );

    const request = {
      method: methodMap[args.operation],
      params: {
        ...args,
        position:
          args.line && args.character
            ? { line: args.line - 1, character: args.character - 1 }
            : undefined,
      },
      filePath: args.filePath,
    };

    try {
      const result = await manager.sendRequest(bash, request);
      return result || "No information found.";
    } catch (error: any) {
      return `LSP Error: ${error.message}`;
    }
  },
});
