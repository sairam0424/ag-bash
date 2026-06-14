import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";

/**
 * ag-grep - High-performance recursive pattern search.
 */
export const agGrepCommand: Command = {
  name: "ag-grep",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const argDefs = {
      path: { short: "p", long: "path", type: "string" as const },
      query: { short: "q", long: "query", type: "string" as const },
      ignoreCase: { short: "i", long: "ignore-case", type: "boolean" as const },
    };

    const parsed = parseArgs("ag-grep", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const { flags, positional } = parsed.result;
    const query = flags.query || positional[0];
    const searchPath = flags.path || positional[1] || ".";

    if (!query) {
      return {
        stdout: "",
        stderr: "Usage: ag-grep <query> [path] [--ignore-case]\n",
        exitCode: 1,
      };
    }

    const absPath = ctx.fs.resolvePath(ctx.cwd, searchPath);
    const results: string[] = [];

    const searchRecursive = async (currentPath: string) => {
      const stat = await ctx.fs.stat(currentPath);

      if (!stat.isDirectory) {
        const content = await ctx.fs.readFile(currentPath, "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          let match = false;
          if (flags.ignoreCase) {
            match = lines[i].toLowerCase().includes(query.toLowerCase());
          } else {
            match = lines[i].includes(query);
          }
          if (match) {
            results.push(`${currentPath}:${i + 1}:${lines[i]}`);
          }
        }
        return;
      }

      const entries = await ctx.fs.readdir(currentPath);
      for (const entry of entries) {
        const fullPath = ctx.fs.resolvePath(currentPath, entry);
        if (entry === "node_modules" || entry === ".git") continue;
        await searchRecursive(fullPath);
      }
    };

    try {
      await searchRecursive(absPath);
      return {
        stdout: results.join("\n") + (results.length > 0 ? "\n" : ""),
        stderr: results.length === 0 ? "No matches found.\n" : "",
        exitCode: 0,
      };
    } catch (error: any) {
      return {
        stdout: "",
        stderr: `ag-grep: ${sanitizeErrorMessage(error.message)}\n`,
        exitCode: 1,
      };
    }
  },
};
