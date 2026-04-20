import { TreeSitterParser } from "../../parser/tree-sitter-parser.js";
import { TreeSitterToAst } from "../../parser/tree-sitter-to-ast.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";
import { SemanticEngine } from "../../lsp/semantic-engine.js";

const agAnalyzeHelp = {
  name: "ag-analyze",
  summary: "analyze code structure and provide summaries",
  usage: "ag-analyze <file> [--symbols]",
  options: [
    "    --symbols     output JSON symbol table",
    "    --help        display this help and exit",
  ],
};

export const agAnalyzeCommand: Command = {
  name: "ag-analyze",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(agAnalyzeHelp);

    const argDefs = {
      symbols: { long: "symbols", type: "boolean" as const },
    };

    const parsed = parseArgs("ag-analyze", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const { flags, positional } = parsed.result;
    const file = positional[0];

    if (!file) {
      return { stdout: "", stderr: "ag-analyze: missing file operand\n", exitCode: 2 };
    }

    const filePath = ctx.fs.resolvePath(ctx.cwd, file);
    if (!(await ctx.fs.exists(filePath))) {
      return { stdout: "", stderr: `ag-analyze: ${file}: No such file or directory\n`, exitCode: 2 };
    }

    const content = await ctx.fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    const isBash = file.endsWith(".sh") || file.endsWith(".bash") || content.startsWith("#!/bin/bash") || content.startsWith("#!/bin/sh");

    if (!isBash) {
       return {
         stdout: `File: ${file}\nLines: ${lines.length}\nSize: ${content.length} bytes\n(Deep semantic analysis currently only supported for Bash scripts)\n`,
         stderr: "",
         exitCode: 0,
       };
    }

    try {
      // 1. Initial Tree-sitter parse
      const tree = TreeSitterParser.parse(content);
      const converter = new TreeSitterToAst(content);
      const ast = converter.convert(tree);

      // 2. Semantic analysis
      const engine = new SemanticEngine(ast);
      const symbols = engine.getAllSymbols();

      if (flags.symbols) {
        return {
          stdout: JSON.stringify(symbols, null, 2) + "\n",
          stderr: "",
          exitCode: 0,
        };
      }

      let summary = `--- Analysis Summary for ${file} ---\n`;
      summary += `Lines: ${lines.length}\n`;
      summary += `Size: ${content.length} bytes\n`;

      const funcs = symbols.filter(s => s.type === "Function");
      const vars = symbols.filter(s => s.type === "Variable");

      if (funcs.length > 0) {
        summary += `\nFunctions (${funcs.length}):\n`;
        funcs.forEach(f => {
          summary += `  - ${f.name} (line ${f.line})\n`;
        });
      } else {
        summary += `\nNo functions defined.\n`;
      }

      if (vars.length > 0) {
        summary += `\nVariables (${vars.length} unique):\n`;
        const uniqueVars = Array.from(new Set(vars.map(v => v.name)));
        summary += `  ${uniqueVars.slice(0, 10).join(", ")}${uniqueVars.length > 10 ? "..." : ""}\n`;
      }

      summary += `-----------------------------------\n`;

      return { stdout: summary, stderr: "", exitCode: 0 };

    } catch (e: any) {
      return {
        stdout: `File: ${file}\nLines: ${lines.length}\n(Error during analysis: ${e.message})\n`,
        stderr: "",
        exitCode: 1,
      };
    }
  },
};

