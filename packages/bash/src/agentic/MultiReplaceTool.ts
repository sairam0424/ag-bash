import { z } from "zod";
import type { Bash } from "../Bash.js";
import { Tool } from "./Tool.js";
import type { ToolboxTool } from "./Tool.js";

/**
 * MultiReplaceTool - Robust multi-chunk file editing tool.
 * 
 * Supports replacing multiple non-contiguous blocks of text in a single operation.
 * Automatically handles quote normalization and provides detailed error reporting.
 */
export const MultiReplaceTool: ToolboxTool = {
  name: "ag_multi_edit",
  description: "Apply multiple non-contiguous text replacements to a file in a single operation.",
  parameters: z.object({
    path: z.string().describe("Absolute path to the file to edit."),
    chunks: z.array(z.object({
      target: z.string().describe("The exact text block to be replaced."),
      replacement: z.string().describe("The new text to insert."),
    })).describe("List of replacement chunks."),
  }),
  isDestructive: true,
  checkPermissions: async (bash: Bash) => {
    return { behavior: "allow" }; // In a real system, we'd check write permissions here
  },
  validateInput: async (args: any) => {
    return { result: true };
  },
  execute: async (
    bash: Bash,
    {
      path,
      chunks,
    }: { path: string; chunks: { target: string; replacement: string }[] },
  ) => {
    try {
      const state = bash.getFileState(path);
      const currentContent = await bash.readFileDirect(path);

      // Staleness check
      if (state && state.content !== currentContent) {
        return `Stale Edit Error: The file ${path} has changed since you last read it. Please read it again before applying edits.`;
      }

      let newContent = currentContent;
      const appliedChunks: string[] = [];
      const failedChunks: { target: string; reason: string }[] = [];

      // Sort chunks by target length descending to avoid partial matches interfering?
      // Actually, we should probably do them one by one and check if they exist.
      // If we do them sequentially, we need to be careful about offsets if targets overlap.
      // However, the rule is usually "non-contiguous".

      for (const chunk of chunks) {
        // We use the current state of newContent for each subsequent replacement
        const normalizedContent = newContent.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
        const normalizedTarget = chunk.target.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

        const index = normalizedContent.indexOf(normalizedTarget);
        if (index === -1) {
          failedChunks.push({ target: chunk.target, reason: "Target not found" });
          continue;
        }

        // Check for multiple occurrences to avoid ambiguity
        if (normalizedContent.indexOf(normalizedTarget, index + 1) !== -1) {
          failedChunks.push({ target: chunk.target, reason: "Multiple occurrences found. Please provide more context." });
          continue;
        }

        // Apply replacement
        newContent = 
          newContent.substring(0, index) + 
          chunk.replacement + 
          newContent.substring(index + chunk.target.length);
        
        appliedChunks.push(chunk.target);
      }

      if (failedChunks.length > 0) {
        return {
          error: "Some chunks failed to apply.",
          applied: appliedChunks,
          failed: failedChunks
        };
      }

      await bash.fs.mkdir("/.ag-bash", { recursive: true });
      await bash.writeFileDirect(path, newContent);
      await bash.indexer.indexFile(path);
      await bash.saveIndex();

      // Notify LSP of changes
      await bash.lsp.notifyDidChange(path, newContent);

      return `Successfully applied ${appliedChunks.length} replacements to ${path}.`;
    } catch (error: any) {
      return `Error in ag_multi_edit for ${path}: ${error.message}`;
    }
  }
};
