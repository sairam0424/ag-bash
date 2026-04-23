import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agHoverHelp = {
  name: "ag-hover",
  summary: "get information about a symbol at a specific position",
  usage: "ag-hover <file> <line> <character>",
  options: ["    --help        display this help and exit"],
};

export const agHoverCommand: Command = {
  name: "ag-hover",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(agHoverHelp);

    const parsed = parseArgs("ag-hover", args, {});
    if (!parsed.ok) return parsed.error;

    const { positional } = parsed.result;
    const file = positional[0];
    const line = parseInt(positional[1]);
    const char = parseInt(positional[2]);

    if (!file || isNaN(line) || isNaN(char)) {
      return {
        stdout: "",
        stderr:
          "ag-hover: missing or invalid arguments\nUsage: ag-hover <file> <line> <character>\n",
        exitCode: 2,
      };
    }

    const filePath = ctx.fs.resolvePath(ctx.cwd, file);
    if (!(await ctx.fs.exists(filePath))) {
      return {
        stdout: "",
        stderr: `ag-hover: ${file}: No such file or directory\n`,
        exitCode: 2,
      };
    }

    try {
      const content = await ctx.fs.readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      const lineText = lines[line - 1] || "";

      // Simple word detection at position
      const symbolPattern = /[\w$!]+/g;
      let symbolName: string | undefined;
      let match;
      while ((match = symbolPattern.exec(lineText)) !== null) {
        if (
          char - 1 >= match.index &&
          char - 1 < match.index + match[0].length
        ) {
          symbolName = match[0];
          break;
        }
      }

      if (!symbolName) {
        return {
          stdout: "No symbol found at position.\n",
          stderr: "",
          exitCode: 0,
        };
      }

      // @ts-expect-error
      const definition = ctx.bash.semanticEngine.findDefinition(symbolName);
      if (definition) {
        let output = `--- Hover Info for '${symbolName}' ---\n`;
        output += `Type: ${definition.type}\n`;
        output += `Scope: ${definition.scope}\n`;
        output += `Defined in: ${definition.path || "current script"} at line ${definition.line}\n`;
        return { stdout: output, stderr: "", exitCode: 0 };
      }

      return {
        stdout: `No semantic info found for '${symbolName}'.\n`,
        stderr: "",
        exitCode: 0,
      };
    } catch (e: any) {
      return {
        stdout: "",
        stderr: `ag-hover: error: ${e.message}\n`,
        exitCode: 1,
      };
    }
  },
};
