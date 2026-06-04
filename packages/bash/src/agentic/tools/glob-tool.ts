import { z } from "zod";
import type { Bash } from "../../Bash.js";
import { buildTool, type ToolboxTool } from "../Tool.js";

interface GlobArgs {
  pattern: string;
  path?: string;
  sort?: string;
  limit?: number;
}

const globParameters: z.ZodType<GlobArgs> = z.object({
  pattern: z
    .string()
    .describe('Glob pattern (e.g., "**/*.ts", "src/**/*.{ts,tsx}").'),
  path: z.string().optional().describe("Root directory (default: cwd)."),
  sort: z.string().optional().describe('"alpha" (default) or "mtime".'),
  limit: z.number().optional().describe("Max results (default: 1000)."),
});

/**
 * glob_files - Fast glob pattern matching over the filesystem.
 *
 * Returns matching file paths sorted by name or modification time.
 * Supports standard glob patterns like **\/*.ts and brace expansion.
 *
 * NOTE: bash.run() here refers to the sandboxed virtual Bash interpreter,
 * NOT Node.js child_process. All execution is contained within the
 * virtual filesystem and controlled environment.
 */
export const GlobTool: ToolboxTool<GlobArgs, string[]> = buildTool({
  name: "glob_files",
  description:
    "Fast glob pattern matching over the filesystem. Returns matching file paths sorted by name or mtime.",
  searchHint: "find files by glob pattern",
  parameters: globParameters,
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async (bash: Bash, input: GlobArgs) => {
    const args = [JSON.stringify(input.pattern)];
    if (input.path) args.push("--path", JSON.stringify(input.path));
    if (input.sort) args.push("--sort", input.sort);
    if (input.limit) args.push("--limit", String(input.limit));
    // Sandboxed virtual Bash interpreter execution (not child_process)
    const result = await bash.exec(`ag-glob ${args.join(" ")}`); // eslint-disable-line security/detect-child-process
    return result.stdout.trim().split("\n").filter(Boolean);
  },
});
