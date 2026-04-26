import { z } from "zod";
import { buildTool } from "./BashToolbox.js";
import { agHoverCommand } from "../commands/ag-hover/ag-hover.js";
import { agFindSymbolCommand } from "../commands/ag-find-symbol/ag-find-symbol.js";
import { agExplainCommand } from "../commands/ag-explain/ag-explain.js";
import type { Bash } from "../Bash.js";
import type { ToolboxTool } from "./Tool.js";

/**
 * ag_hover - Agentic tool for getting information about a symbol at a specific position.
 */
export const HoverTool: ToolboxTool = buildTool({
  name: "ag_hover",
  description: "Get semantic information about a symbol at a specific line and character position.",
  parameters: z.object({
    filePath: z.string().describe("Path to the file containing the symbol."),
    line: z.number().describe("1-indexed line number."),
    character: z.number().describe("1-indexed character position."),
  }),
  isReadOnly: true,
  execute: async (bash: Bash, args: any) => {
    const result = await agHoverCommand.execute([args.filePath, args.line.toString(), args.character.toString()], {
      fs: bash.fs,
      cwd: bash.cwd,
      env: bash.env,
      stdin: "",
      bash,
    } as any);

    return result.stdout || result.stderr || "No information found.";
  },
});

/**
 * ag_find_symbol - Agentic tool for searching symbols across the workspace.
 */
export const FindSymbolTool: ToolboxTool = buildTool({
  name: "ag_find_symbol",
  description: "Search for symbols (functions, variables, classes) by name or pattern across the workspace.",
  parameters: z.object({
    query: z.string().describe("The symbol name or search pattern."),
    type: z.enum(["Variable", "Function", "Command", "File", "Class", "Module"]).optional().describe("Filter by symbol type."),
  }),
  isReadOnly: true,
  execute: async (bash: Bash, args: any) => {
    const cmdArgs = [args.query];
    if (args.type) cmdArgs.push("--type", args.type);

    const result = await agFindSymbolCommand.execute(cmdArgs, {
      fs: bash.fs,
      cwd: bash.cwd,
      env: bash.env,
      stdin: "",
      bash,
    } as any);

    return result.stdout || result.stderr || "No symbols found.";
  },
});

/**
 * ag_explain - Agentic tool for explaining shell commands.
 */
export const ExplainTool: ToolboxTool = buildTool({
  name: "ag_explain",
  description: "Parse and explain a shell command string, showing its structure and components.",
  parameters: z.object({
    command: z.string().describe("The shell command string to explain."),
  }),
  isReadOnly: true,
  execute: async (bash: Bash, args: any) => {
    const result = await agExplainCommand.execute([args.command], {
      fs: bash.fs,
      cwd: bash.cwd,
      env: bash.env,
      stdin: "",
      bash,
    } as any);

    return result.stdout || result.stderr;
  },
});
