import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";

/**
 * ag-find-files - High-performance recursive file search by name.
 */
export const agFindFilesCommand: Command = {
  name: "ag-find-files",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const argDefs = {
      path: { short: "p", long: "path", type: "string" as const },
      name: { short: "n", long: "name", type: "string" as const },
    };

    const parsed = parseArgs("ag-find-files", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const { flags, positional } = parsed.result;
    const namePattern = flags.name || positional[0];
    const searchPath = flags.path || positional[1] || ".";

    if (!namePattern) {
      return {
        stdout: "",
        stderr: "Usage: ag-find-files <name_pattern> [path]\n",
        exitCode: 1,
      };
    }

    const absPath = ctx.fs.resolvePath(ctx.cwd, searchPath);
    const results: string[] = [];

    const findRecursive = async (currentPath: string) => {
      const stat = await ctx.fs.stat(currentPath);

      const fileName = currentPath.split("/").pop() || "";
      if (fileName.includes(namePattern)) {
        results.push(currentPath);
      }

      if (!stat.isDirectory) return;

      const entries = await ctx.fs.readdir(currentPath);
      for (const entry of entries) {
        const fullPath = ctx.fs.resolvePath(currentPath, entry);
        if (entry === "node_modules" || entry === ".git") continue;
        await findRecursive(fullPath);
      }
    };

    try {
      await findRecursive(absPath);
      return {
        stdout: results.join("\n") + (results.length > 0 ? "\n" : ""),
        stderr: results.length === 0 ? "No matching files found.\n" : "",
        exitCode: 0,
      };
    } catch (error: any) {
      return {
        stdout: "",
        stderr: `ag-find-files: ${error.message}\n`,
        exitCode: 1,
      };
    }
  },
};
