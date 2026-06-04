import { z } from "zod";
import type { Bash } from "../Bash.js";
import { agFindFilesCommand } from "../commands/ag-find-files/ag-find-files.js";
import { agGrepCommand } from "../commands/ag-grep/ag-grep.js";
import { buildTool, type ToolboxTool } from "./Tool.js";

interface GrepArgs {
  query: string;
  path?: string;
  ignoreCase?: boolean;
}

const grepParameters: z.ZodType<GrepArgs> = z.object({
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
});

/**
 * ag_grep - Agentic tool for high-performance recursive pattern search.
 */
export const GrepTool: ToolboxTool<GrepArgs, string> = buildTool({
  name: "ag_grep",
  description: "High-performance recursive pattern search within files.",
  parameters: grepParameters,
  isReadOnly: true,
  execute: async (bash: Bash, args: GrepArgs) => {
    const cmdArgs = [args.query];
    if (args.path) cmdArgs.push(args.path);
    if (args.ignoreCase) cmdArgs.push("--ignore-case");

    const result = await agGrepCommand.execute(cmdArgs, {
      fs: bash.fs,
      cwd: bash.cwd,
      env: bash.env,
      stdin: "",
      bash,
      // biome-ignore lint/suspicious/noExplicitAny: Internal command context shim — Bash's private `agentic` field blocks structural assignment to CommandContext.bash (BashHost), and bash.env is a Record vs the Map the context expects.
    } as any);

    return result.stdout || result.stderr || "No matches found.";
  },
});

interface FindFilesArgs {
  pattern: string;
  path?: string;
}

const findFilesParameters: z.ZodType<FindFilesArgs> = z.object({
  pattern: z.string().describe("The filename or glob pattern to search for."),
  path: z
    .string()
    .optional()
    .describe(
      "The directory to start searching from (default: current directory).",
    ),
});

/**
 * ag_find_files - Agentic tool for finding files by name or glob pattern.
 */
export const FindFilesTool: ToolboxTool<FindFilesArgs, string> = buildTool({
  name: "ag_find_files",
  description: "Find files by name or glob pattern recursively.",
  parameters: findFilesParameters,
  isReadOnly: true,
  execute: async (bash: Bash, args: FindFilesArgs) => {
    const cmdArgs = [args.pattern];
    if (args.path) cmdArgs.push(args.path);

    const result = await agFindFilesCommand.execute(cmdArgs, {
      fs: bash.fs,
      cwd: bash.cwd,
      env: bash.env,
      stdin: "",
      bash,
      // biome-ignore lint/suspicious/noExplicitAny: Internal command context shim — Bash's private `agentic` field blocks structural assignment to CommandContext.bash (BashHost), and bash.env is a Record vs the Map the context expects.
    } as any);

    return result.stdout || result.stderr || "No matching files found.";
  },
});
