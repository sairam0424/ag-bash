import { z } from "zod";
import type { ToolboxTool } from "../agentic/Tool.js";
import type { Bash } from "../Bash.js";

/**
 * ag_lsp: Unified tool for code intelligence.
 */
export const LspTool: ToolboxTool = {
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
  checkPermissions: async (_bash: Bash, _args: any) => ({ behavior: "allow" }),
  validateInput: async (_args: any) => ({ result: true }),
  execute: async (bash: Bash, args: any) => {
    const manager = bash.services.lspManager;

    // Map operation names to LSP methods
    const methodMap: Record<string, string> = Object.assign(Object.create(null), {
      goToDefinition: "textDocument/definition",
      typeDefinition: "textDocument/typeDefinition",
      implementation: "textDocument/implementation",
      findReferences: "textDocument/references",
      hover: "textDocument/hover",
      documentSymbol: "textDocument/documentSymbol",
      workspaceSymbol: "workspace/symbol",
      diagnostics: "textDocument/publishDiagnostics", // Note: This is usually a notification, but we might simulate a poll
    });

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
};
