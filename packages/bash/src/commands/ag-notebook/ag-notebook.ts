/**
 * ag-notebook command - Handle Jupyter Notebook (.ipynb) files.
 *
 * Subcommands:
 * - read <path> : Read notebook content in a human-readable format
 * - edit <path> <cell_index> <content> : Edit a specific cell
 * - add <path> <type> <content> : Add a new cell (type: code|markdown)
 */

import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";

interface NotebookCell {
  cell_type: "code" | "markdown";
  source: string[];
  outputs?: any[];
  execution_count?: number | null;
  metadata?: any;
}

interface NotebookContent {
  cells: NotebookCell[];
  metadata: any;
  nbformat: number;
  nbformat_minor: number;
}

export const agNotebookCommand: Command = {
  name: "ag-notebook",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    const bash = ctx.bash;
    if (!bash)
      return { stdout: "", stderr: "Bash instance not found\n", exitCode: 1 };

    const subcommand = args[0];
    const path = args[1];

    if (!subcommand || !path) {
      return {
        stdout: "",
        stderr: "Usage: ag-notebook <read|edit|add> <path> [args]\n",
        exitCode: 1,
      };
    }

    try {
      const filePath = ctx.fs.resolvePath(ctx.cwd, path);
      if (!(await ctx.fs.exists(filePath))) {
        return {
          stdout: "",
          stderr: `File not found: ${path} (resolved to ${filePath})\n`,
          exitCode: 1,
        };
      }

      const content: NotebookContent = JSON.parse(
        await ctx.fs.readFile(filePath, "utf8"),
      );

      switch (subcommand) {
        case "read": {
          let output = `Notebook: ${path}\n\n`;
          content.cells.forEach((cell, i) => {
            output += `--- Cell ${i} [${cell.cell_type}] ---\n`;
            output += `${cell.source.join("")}\n\n`;
          });
          return { stdout: output, stderr: "", exitCode: 0 };
        }

        case "edit": {
          const cellIndex = parseInt(args[2], 10);
          const newSource = args.slice(3).join(" ");
          if (Number.isNaN(cellIndex) || !newSource) {
            return {
              stdout: "",
              stderr: "Usage: ag-notebook edit <path> <index> <content>\n",
              exitCode: 1,
            };
          }
          if (cellIndex < 0 || cellIndex >= content.cells.length) {
            return { stdout: "", stderr: "Invalid cell index\n", exitCode: 1 };
          }
          content.cells[cellIndex].source = [newSource];
          await ctx.fs.writeFile(filePath, JSON.stringify(content, null, 2));
          return {
            stdout: `Successfully updated cell ${cellIndex}.\n`,
            stderr: "",
            exitCode: 0,
          };
        }

        case "add": {
          const type = args[2] as "code" | "markdown";
          const source = args.slice(3).join(" ");
          if (!type || !source) {
            return {
              stdout: "",
              stderr:
                "Usage: ag-notebook add <path> <code|markdown> <content>\n",
              exitCode: 1,
            };
          }
          const newCell: NotebookCell = {
            cell_type: type,
            source: [source],
            metadata: Object.create(null),
          };
          if (type === "code") {
            newCell.outputs = [];
            newCell.execution_count = null;
          }
          content.cells.push(newCell);
          await ctx.fs.writeFile(filePath, JSON.stringify(content, null, 2));
          return {
            stdout: `Successfully added new ${type} cell.\n`,
            stderr: "",
            exitCode: 0,
          };
        }

        default:
          return {
            stdout: "",
            stderr: `Unknown subcommand: ${subcommand}\n`,
            exitCode: 1,
          };
      }
    } catch (e: any) {
      return { stdout: "", stderr: `Error: ${sanitizeErrorMessage(e.message)}\n`, exitCode: 1 };
    }
  },
};
