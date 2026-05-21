import { minimatch } from "minimatch";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";

/**
 * ag-glob - Fast glob pattern matching over the virtual filesystem.
 *
 * Recursively walks the filesystem from a root directory and returns
 * all file paths matching the given glob pattern.
 */
export const agGlobCommand: Command = {
  name: "ag-glob",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp({
        name: "ag-glob",
        summary: "Fast glob pattern matching over the virtual filesystem",
        usage: "ag-glob <pattern> [--path <dir>] [--sort mtime] [--limit <n>]",
        description: [
          "Recursively walks the filesystem and returns all file paths",
          "matching the given glob pattern. Supports standard glob syntax",
          "including **, *, ?, and brace expansion {a,b}.",
        ],
        options: [
          "-p, --path <dir>    Root directory to search from (default: cwd)",
          "-s, --sort <mode>   Sort order: alpha (default) or mtime",
          "-l, --limit <n>     Maximum number of results (default: 1000)",
        ],
        examples: [
          'ag-glob "**/*.ts"',
          'ag-glob "src/**/*.{ts,tsx}" --path /project',
          'ag-glob "*.json" --sort mtime --limit 10',
        ],
      });
    }

    const argDefs = {
      path: { short: "p", long: "path", type: "string" as const },
      sort: { short: "s", long: "sort", type: "string" as const },
      limit: {
        short: "l",
        long: "limit",
        type: "number" as const,
        default: 1000,
      },
    };

    const parsed = parseArgs("ag-glob", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const { flags, positional } = parsed.result;
    const pattern = positional[0];
    const searchPath = flags.path || positional[1] || ".";
    const sortMode = flags.sort || "alpha";
    const limit = flags.limit;

    if (!pattern) {
      return {
        stdout: "",
        stderr:
          "Usage: ag-glob <pattern> [--path <dir>] [--sort mtime] [--limit <n>]\n",
        exitCode: 1,
      };
    }

    if (sortMode !== "alpha" && sortMode !== "mtime") {
      return {
        stdout: "",
        stderr: `ag-glob: invalid sort mode '${sortMode}' (expected 'alpha' or 'mtime')\n`,
        exitCode: 1,
      };
    }

    const absPath = ctx.fs.resolvePath(ctx.cwd, searchPath);
    const results: { path: string; mtime: Date }[] = [];

    const walkRecursive = async (currentPath: string) => {
      const stat = await ctx.fs.stat(currentPath);

      if (!stat.isDirectory) {
        // Compute relative path from the search root for matching
        const relativePath = currentPath.startsWith(`${absPath}/`)
          ? currentPath.slice(absPath.length + 1)
          : currentPath === absPath
            ? currentPath.split("/").pop() || ""
            : currentPath;

        if (minimatch(relativePath, pattern, { dot: true })) {
          results.push({ path: currentPath, mtime: stat.mtime });
        }
        return;
      }

      const entries = await ctx.fs.readdir(currentPath);
      for (const entry of entries) {
        if (entry === "node_modules" || entry === ".git") continue;
        const fullPath = ctx.fs.resolvePath(currentPath, entry);
        await walkRecursive(fullPath);
      }
    };

    try {
      await walkRecursive(absPath);

      // Sort results
      if (sortMode === "mtime") {
        results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      } else {
        results.sort((a, b) => a.path.localeCompare(b.path));
      }

      // Apply limit
      const limited = results.slice(0, limit);
      const paths = limited.map((r) => r.path);

      return {
        stdout: paths.join("\n") + (paths.length > 0 ? "\n" : ""),
        stderr: paths.length === 0 ? "No matching files found.\n" : "",
        exitCode: 0,
      };
    } catch (error: any) {
      return {
        stdout: "",
        stderr: `ag-glob: ${error.message}\n`,
        exitCode: 1,
      };
    }
  },
};
