import { z } from "zod";
import type { Bash } from "../Bash.js";
import { agExplainCommand } from "../commands/ag-explain/ag-explain.js";
import { agFindSymbolCommand } from "../commands/ag-find-symbol/ag-find-symbol.js";
import { agHoverCommand } from "../commands/ag-hover/ag-hover.js";
import { buildTool, type ToolboxTool } from "./Tool.js";

interface HoverArgs {
  filePath: string;
  line: number;
  character: number;
}

const hoverParameters: z.ZodType<HoverArgs> = z.object({
  filePath: z.string().describe("Path to the file containing the symbol."),
  line: z.number().describe("1-indexed line number."),
  character: z.number().describe("1-indexed character position."),
});

/**
 * ag_hover - Agentic tool for getting information about a symbol at a specific position.
 */
export const HoverTool: ToolboxTool<HoverArgs, string> = buildTool({
  name: "ag_hover",
  description:
    "Get semantic information about a symbol at a specific line and character position.",
  parameters: hoverParameters,
  isReadOnly: true,
  execute: async (bash: Bash, args: HoverArgs) => {
    const result = await agHoverCommand.execute(
      [args.filePath, args.line.toString(), args.character.toString()],
      {
        fs: bash.fs,
        cwd: bash.cwd,
        env: bash.env,
        stdin: "",
        bash,
        // biome-ignore lint/suspicious/noExplicitAny: Internal command context shim — Bash's private `agentic` field blocks structural assignment to CommandContext.bash (BashHost), and bash.env is a Record vs the Map the context expects.
      } as any,
    );

    return result.stdout || result.stderr || "No information found.";
  },
});

interface FindSymbolArgs {
  query: string;
  type?: "Variable" | "Function" | "Command" | "File" | "Class" | "Module";
}

const findSymbolParameters: z.ZodType<FindSymbolArgs> = z.object({
  query: z.string().describe("The symbol name or search pattern."),
  type: z
    .enum(["Variable", "Function", "Command", "File", "Class", "Module"])
    .optional()
    .describe("Filter by symbol type."),
});

/**
 * ag_find_symbol - Agentic tool for searching symbols across the workspace.
 */
export const FindSymbolTool: ToolboxTool<FindSymbolArgs, string> = buildTool({
  name: "ag_find_symbol",
  description:
    "Search for symbols (functions, variables, classes) by name or pattern across the workspace.",
  parameters: findSymbolParameters,
  isReadOnly: true,
  execute: async (bash: Bash, args: FindSymbolArgs) => {
    const cmdArgs = [args.query];
    if (args.type) cmdArgs.push("--type", args.type);

    const result = await agFindSymbolCommand.execute(cmdArgs, {
      fs: bash.fs,
      cwd: bash.cwd,
      env: bash.env,
      stdin: "",
      bash,
      // biome-ignore lint/suspicious/noExplicitAny: Internal command context shim — Bash's private `agentic` field blocks structural assignment to CommandContext.bash (BashHost), and bash.env is a Record vs the Map the context expects.
    } as any);

    return result.stdout || result.stderr || "No symbols found.";
  },
});

interface ExplainArgs {
  command: string;
}

const explainParameters: z.ZodType<ExplainArgs> = z.object({
  command: z.string().describe("The shell command string to explain."),
});

/**
 * ag_explain - Agentic tool for explaining shell commands.
 */
export const ExplainTool: ToolboxTool<ExplainArgs, string> = buildTool({
  name: "ag_explain",
  description:
    "Parse and explain a shell command string, showing its structure and components.",
  parameters: explainParameters,
  isReadOnly: true,
  execute: async (bash: Bash, args: ExplainArgs) => {
    const result = await agExplainCommand.execute([args.command], {
      fs: bash.fs,
      cwd: bash.cwd,
      env: bash.env,
      stdin: "",
      bash,
      // biome-ignore lint/suspicious/noExplicitAny: Internal command context shim — Bash's private `agentic` field blocks structural assignment to CommandContext.bash (BashHost), and bash.env is a Record vs the Map the context expects.
    } as any);

    return result.stdout || result.stderr;
  },
});
