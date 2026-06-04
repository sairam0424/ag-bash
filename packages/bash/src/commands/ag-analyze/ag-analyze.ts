import {
  SemanticEngine,
  type SemanticSymbol,
  SymbolType,
} from "../../lsp/semantic-engine.js";
import { TreeSitterParser } from "../../parser/tree-sitter-parser.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";

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
      return {
        stdout: "",
        stderr: "ag-analyze: missing file operand\n",
        exitCode: 2,
      };
    }

    const filePath = ctx.fs.resolvePath(ctx.cwd, file);
    if (!(await ctx.fs.exists(filePath))) {
      return {
        stdout: "",
        stderr: `ag-analyze: ${file}: No such file or directory\n`,
        exitCode: 2,
      };
    }

    const content = await ctx.fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    const getLanguage = (f: string) => {
      if (f.endsWith(".py")) return "python";
      if (f.endsWith(".js") || f.endsWith(".ts")) return "javascript";
      if (f.endsWith(".json")) return "json";
      if (
        f.endsWith(".sh") ||
        f.endsWith(".bash") ||
        content.startsWith("#!/bin/bash") ||
        content.startsWith("#!/bin/sh")
      ) {
        return "bash";
      }
      return "unknown";
    };

    const language = getLanguage(file);

    if (language === "unknown") {
      return {
        stdout:
          `File: ${file}\n` +
          `Lines: ${lines.length}\n` +
          `Size: ${content.length} bytes\n` +
          `(Deep semantic analysis currently only supported for Bash scripts)\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    try {
      const engine = ctx.bash?.semanticEngine ?? new SemanticEngine();

      if (language === "bash") {
        const { parse } = await import("../../parser/parser.js");
        const ast = parse(content);
        engine.indexNode(ast, filePath, "bash");
      } else {
        const tree = TreeSitterParser.parse(content, language);
        engine.indexNode(tree.rootNode, filePath, language);
      }

      const symbols = engine.getAllSymbols();

      if (flags.symbols) {
        return {
          stdout: `${JSON.stringify(symbols, null, 2)}\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      let summary = `--- Analysis Summary for ${file} (${language}) ---\n`;
      summary += `Lines: ${lines.length}\n`;
      summary += `Size: ${content.length} bytes\n`;

      const funcs = symbols.filter(
        (s: SemanticSymbol) => s.type === SymbolType.Function,
      );
      const classes = symbols.filter(
        (s: SemanticSymbol) => s.type === SymbolType.Class,
      );
      const vars = symbols.filter(
        (s: SemanticSymbol) => s.type === SymbolType.Variable,
      );

      if (classes.length > 0) {
        summary += `\nClasses (${classes.length}):\n`;
        classes.forEach((c: SemanticSymbol) => {
          summary += `  - class ${c.name} (line ${c.line})\n`;
        });
      }

      if (funcs.length > 0) {
        summary += `\nFunctions (${funcs.length}):\n`;
        funcs.forEach((f: SemanticSymbol) => {
          summary += `  - ${f.name} (line ${f.line})\n`;
        });
      } else if (classes.length === 0) {
        summary += `\nNo major symbols defined.\n`;
      }

      if (vars.length > 0) {
        summary += `\nVariables (${vars.length} unique):\n`;
        const uniqueVars = Array.from(
          new Set(vars.map((v: SemanticSymbol) => v.name)),
        );
        summary += `  ${uniqueVars.slice(0, 10).join(", ")}${uniqueVars.length > 10 ? "..." : ""}\n`;
      }

      summary += `-----------------------------------\n`;

      return { stdout: summary, stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        stdout: `File: ${file}\nLines: ${lines.length}\n(Error during analysis: ${message})\n`,
        stderr: "",
        exitCode: 1,
      };
    }
  },
};
