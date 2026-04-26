import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";

/**
 * ag-edit - Agentic line-based file editor
 *
 * Usage: ag-edit <file> <action> [options]
 *
 * Actions:
 *   insert-before --line <N> --text <TEXT>
 *   insert-after  --line <N> --text <TEXT>
 *   replace       --line <N> [--to <M>] --text <TEXT>
 *   delete        --line <N> [--to <M>]
 *   append        --text <TEXT>
 *   prepend       --text <TEXT>
 */
export const agEditCommand: Command = {
  name: "ag-edit",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (args.length < 2) {
      return {
        stdout: "",
        stderr: "Usage: ag-edit <file> <action> [options]\n",
        exitCode: 1,
      };
    }

    const argDefs = {
      line: { short: "n", long: "line", type: "number" as const },
      to: { short: "t", long: "to", type: "number" as const },
      text: { short: "x", long: "text", type: "string" as const },
      dryRun: { long: "dry-run", type: "boolean" as const },
    };

    const parsed = parseArgs("ag-edit", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const { flags, positional } = parsed.result;
    const action = positional[0];
    const file = positional[1];

    if (!action || !file) {
      return {
        stdout: "",
        stderr:
          "usage: ag-edit <action> <file> [-n line] [-t to] [-x text] [--dry-run]\n",
        exitCode: 1,
      };
    }

    const filePath = ctx.fs.resolvePath(ctx.cwd, file);
    if (!(await ctx.fs.exists(filePath))) {
      return {
        stdout: "",
        stderr: `ag-edit: ${file}: No such file or directory\n`,
        exitCode: 1,
      };
    }

    const content = await ctx.fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const originalLineCount = lines.length;

    const newTextInput = flags.text || "";
    // Handle literal \n in text input if provided as a string from some UIs
    const newText = newTextInput.replace(/\\n/g, "\n");
    const newLines = newText.split("\n");

    const startIdx = flags.line !== undefined ? flags.line - 1 : undefined;
    const endIdx = flags.to !== undefined ? flags.to - 1 : startIdx;

    // Validation
    if (
      ["insert-before", "insert-after", "replace", "delete"].includes(action)
    ) {
      if (startIdx === undefined || Number.isNaN(startIdx))
        return error("missing or invalid --line");
      if (
        startIdx < 0 ||
        (action !== "insert-after" && startIdx >= originalLineCount)
      ) {
        return error(
          `line ${flags.line} out of range (1-${originalLineCount})`,
        );
      }
    }

    let summary = "";

    switch (action) {
      case "insert-before":
        lines.splice(startIdx!, 0, ...newLines);
        summary = `Inserted ${newLines.length} line(s) before line ${flags.line}`;
        break;
      case "insert-after":
        lines.splice(startIdx! + 1, 0, ...newLines);
        summary = `Inserted ${newLines.length} line(s) after line ${flags.line}`;
        break;
      case "replace":
        if (
          endIdx === undefined ||
          Number.isNaN(endIdx) ||
          endIdx < startIdx!
        ) {
          return error("invalid range for replace");
        }
        if (endIdx >= originalLineCount)
          return error(`range end ${flags.to} out of range`);
        lines.splice(startIdx!, endIdx! - startIdx! + 1, ...newLines);
        summary = `Replaced lines ${flags.line}-${flags.to || flags.line} with ${newLines.length} line(s)`;
        break;
      case "delete":
        if (
          endIdx === undefined ||
          Number.isNaN(endIdx) ||
          endIdx < startIdx!
        ) {
          return error("invalid range for delete");
        }
        if (endIdx >= originalLineCount)
          return error(`range end ${flags.to} out of range`);
        lines.splice(startIdx!, endIdx! - startIdx! + 1);
        summary = `Deleted lines ${flags.line}-${flags.to || flags.line}`;
        break;
      case "append":
        lines.push(...newLines);
        summary = `Appended ${newLines.length} line(s)`;
        break;
      case "prepend":
        lines.unshift(...newLines);
        summary = `Prepended ${newLines.length} line(s)`;
        break;
      default:
        return {
          stdout: "",
          stderr: `ag-edit: unknown action: ${action}\n`,
          exitCode: 1,
        };
    }

    const newContent = lines.join("\n");

    if (flags.dryRun) {
      return {
        stdout: `[DRY RUN] ${summary} in ${file}\nProposed content length: ${newContent.length} bytes\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    try {
      await ctx.fs.writeFile(filePath, newContent);

      // Notify LSP of changes if running within a Bash instance
      if (ctx.bash?.lsp) {
        ctx.bash.lsp.notifyDidChange(filePath, newContent);
      }

      return {
        stdout: `Successfully updated ${file}: ${summary}\n`,
        stderr: "",
        exitCode: 0,
      };
    } catch (e: any) {
      return {
        stdout: "",
        stderr: `ag-edit: failed to write ${file}: ${e.message}\n`,
        exitCode: 1,
      };
    }

    function error(msg: string): ExecResult {
      return {
        stdout: "",
        stderr: `ag-edit: ${msg}\n`,
        exitCode: 1,
      };
    }
  },
};
