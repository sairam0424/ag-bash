import { z } from "zod";
import type { Bash } from "../../Bash.js";
import { buildTool, type ToolboxTool } from "../Tool.js";

/**
 * list_dir - List contents of a directory.
 *
 * Returns a newline-separated list of file and directory names
 * within the specified path.
 */
export const ListDirTool: ToolboxTool = buildTool({
  name: "list_dir",
  description: "List contents of a directory.",
  parameters: z.object({
    path: z.string().describe("Absolute path to the directory to list."),
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async (bash: Bash, { path }: { path: string }) => {
    try {
      const files = await bash.listDirDirect(path);
      return files.join("\n");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error listing directory ${path}: ${message}`;
    }
  },
});
