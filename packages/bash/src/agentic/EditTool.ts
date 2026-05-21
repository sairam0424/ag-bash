import { z } from "zod";
import type { Bash } from "../Bash.js";
import { agEditCommand } from "../commands/ag-edit/ag-edit.js";
import { hashFile } from "../utils/crypto.js";
import { buildTool, type ToolboxTool } from "./Tool.js";

/**
 * ag_edit - Agentic file editor with multi-chunk support and staleness protection.
 */
export const EditTool: ToolboxTool = buildTool({
  name: "ag_edit",
  description:
    "Advanced line-based file editor. Supports multiple non-contiguous edits in a single call and protects against stale writes using content hashes.",
  parameters: z.object({
    filePath: z.string().describe("Absolute path to the file to edit."),
    edits: z
      .array(
        z.object({
          action: z.enum([
            "insert-before",
            "insert-after",
            "replace",
            "delete",
            "append",
            "prepend",
          ]),
          line: z.number().optional().describe("Line number for the action."),
          to: z
            .number()
            .optional()
            .describe("End line number for 'replace' and 'delete'."),
          text: z
            .string()
            .optional()
            .describe("Text to insert or replace with."),
        }),
      )
      .describe("List of edits to apply sequentially."),
    expectedHash: z
      .string()
      .optional()
      .describe(
        "The expected SHA-256 hash of the file content before applying edits. If it doesn't match, the edit will fail.",
      ),
  }),
  isDestructive: true,
  execute: async (bash: Bash, args: any) => {
    const path = bash.fs.resolvePath(bash.cwd, args.filePath);

    if (!(await bash.fs.exists(path))) {
      throw new Error(`File not found: ${args.filePath}`);
    }

    const _currentContent = await bash.fs.readFile(path, "utf8");

    // Hash verification
    if (args.expectedHash) {
      const actualHash = await hashFile(bash.fs, path);
      if (actualHash !== args.expectedHash) {
        return `Stale Edit Error: The file ${args.filePath} has changed. Expected hash ${args.expectedHash}, but found ${actualHash}. Please read the file again.`;
      }
    }

    // Apply edits sequentially
    const results: string[] = [];

    for (const edit of args.edits) {
      const cmdArgs = [edit.action, path];
      if (edit.line) cmdArgs.push("--line", edit.line.toString());
      if (edit.to) cmdArgs.push("--to", edit.to.toString());
      if (edit.text) cmdArgs.push("--text", edit.text);

      const result = await agEditCommand.execute(cmdArgs, {
        fs: bash.fs,
        cwd: bash.cwd,
        env: new Map(Object.entries(bash.env)),
        stdin: "",
        bash,
        // biome-ignore lint/suspicious/noExplicitAny: Internal command context shim
      } as any);

      if (result.exitCode !== 0) {
        throw new Error(
          `Edit failed at action ${edit.action}: ${result.stderr}`,
        );
      }
      results.push(result.stdout?.trim() || "Applied edit.");
    }

    return results.join("\n");
  },
});
