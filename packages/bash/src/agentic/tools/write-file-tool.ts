import { z } from "zod";
import type { Bash } from "../../Bash.js";
import { buildTool, type ToolboxTool } from "../Tool.js";

interface WriteFileArgs {
  path: string;
  content: string;
}

const writeFileParameters: z.ZodType<WriteFileArgs> = z.object({
  path: z.string().describe("Absolute path to the file to write."),
  content: z.string().describe("The content to write to the file."),
});

/**
 * write_file - Create or overwrite a file in the virtual filesystem.
 *
 * Writes content to the specified path, indexes it for semantic search,
 * and notifies the LSP of the change.
 */
export const WriteFileTool: ToolboxTool<WriteFileArgs, string> = buildTool({
  name: "write_file",
  description: "Create or overwrite a file in the virtual filesystem.",
  parameters: writeFileParameters,
  isDestructive: true,
  execute: async (bash: Bash, { path, content }: WriteFileArgs) => {
    try {
      await bash.fs.mkdir("/.ag-bash", { recursive: true });
      await bash.writeFileDirect(path, content);
      await bash.indexer.indexFile(path);
      await bash.saveIndex();
      await bash.lsp.notifyDidChange(path, content);
      return `Successfully wrote to ${path}.`;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error writing file ${path}: ${message}`;
    }
  },
});
