import { z } from "zod";
import type { Bash } from "../../Bash.js";
import { buildTool, type ToolboxTool } from "../Tool.js";

/**
 * read_file - Read file contents from the virtual filesystem.
 *
 * Reads the content of a file at the specified absolute path and
 * updates the internal file state cache for staleness detection.
 */
export const ReadFileTool: ToolboxTool = buildTool({
  name: "read_file",
  description: "Read the contents of a file from the virtual filesystem.",
  parameters: z.object({
    path: z.string().describe("Absolute path to the file to read."),
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async (bash: Bash, { path }: { path: string }) => {
    try {
      const content = await bash.fs.readFile(path, "utf-8");
      bash.updateFileState(path, { content });
      return content;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error reading file: ${message}`;
    }
  },
});
