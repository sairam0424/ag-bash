import { z } from "zod";
import type { ToolboxTool } from "../agentic/BashToolbox.js";
import type { Bash } from "../Bash.js";
import { LSPManager } from "./LSPManager.js";

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
        "findReferences",
        "hover",
        "documentSymbol",
        "workspaceSymbol",
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
  execute: async (bash, args) => {
    const manager = LSPManager.getInstance();

    // Map operation names to LSP methods
    const methodMap: Record<string, string> = {
      goToDefinition: "textDocument/definition",
      findReferences: "textDocument/references",
      hover: "textDocument/hover",
      documentSymbol: "textDocument/documentSymbol",
      workspaceSymbol: "workspace/symbol",
    };

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
