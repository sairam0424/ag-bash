import { z } from "zod";
import type { Bash } from "../Bash.js";
import { agFindFilesCommand } from "../commands/ag-find-files/ag-find-files.js";
import { agGrepCommand } from "../commands/ag-grep/ag-grep.js";
import { buildTool, type ToolboxTool } from "./Tool.js";

/**
 * ag_grep - Agentic tool for high-performance recursive pattern search.
 */
export const GrepTool: ToolboxTool = buildTool({
  name: "ag_grep",
  description: "High-performance recursive pattern search within files.",
  parameters: z.object({
    query: z.string().describe("The pattern or string to search for."),
    path: z
      .string()
      .optional()
      .describe(
        "The directory or file to search in (default: current directory).",
      ),
    ignoreCase: z
      .boolean()
      .optional()
      .describe("Whether to ignore case when searching."),
  }),
  isReadOnly: true,
  execute: async (bash: Bash, args: any) => {
    const cmdArgs = [args.query];
    if (args.path) cmdArgs.push(args.path);
    if (args.ignoreCase) cmdArgs.push("--ignore-case");

    const result = await agGrepCommand.execute(cmdArgs, {
      fs: bash.fs,
      cwd: bash.cwd,
      env: bash.env,
      stdin: "",
      bash,
    } as any);

    return result.stdout || result.stderr || "No matches found.";
  },
});

/**
 * ag_find_files - Agentic tool for finding files by name or glob pattern.
 */
export const FindFilesTool: ToolboxTool = buildTool({
  name: "ag_find_files",
  description: "Find files by name or glob pattern recursively.",
  parameters: z.object({
    pattern: z.string().describe("The filename or glob pattern to search for."),
    path: z
      .string()
      .optional()
      .describe(
        "The directory to start searching from (default: current directory).",
      ),
  }),
  isReadOnly: true,
  execute: async (bash: Bash, args: any) => {
    const cmdArgs = [args.pattern];
    if (args.path) cmdArgs.push(args.path);

    const result = await agFindFilesCommand.execute(cmdArgs, {
      fs: bash.fs,
      cwd: bash.cwd,
      env: bash.env,
      stdin: "",
      bash,
    } as any);

    return result.stdout || result.stderr || "No matching files found.";
  },
});
