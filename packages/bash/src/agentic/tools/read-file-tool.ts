import { z } from "zod";
import type { Bash } from "../../Bash.js";
import { buildTool, type ToolboxTool } from "../Tool.js";

interface ReadFileArgs {
  path: string;
}

const readFileParameters: z.ZodType<ReadFileArgs> = z.object({
  path: z.string().describe("Absolute path to the file to read."),
});

/**
 * read_file - Read file contents from the virtual filesystem.
 *
 * Reads the content of a file at the specified absolute path and
 * updates the internal file state cache for staleness detection.
 */
export const ReadFileTool: ToolboxTool<ReadFileArgs, string> = buildTool({
  name: "read_file",
  description: "Read the contents of a file from the virtual filesystem.",
  parameters: readFileParameters,
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async (bash: Bash, { path }: ReadFileArgs) => {
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
