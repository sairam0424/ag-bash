import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agReferencesHelp = {
  name: "ag-references",
  summary: "find all references to a symbol",
  usage: "ag-references <symbol_name>",
  options: ["    --help        display this help and exit"],
};

export const agReferencesCommand: Command = {
  name: "ag-references",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(agReferencesHelp);

    const parsed = parseArgs("ag-references", args, Object.create(null));
    if (!parsed.ok) return parsed.error;

    const { positional } = parsed.result;
    const name = positional[0];

    if (!name) {
      return {
        stdout: "",
        stderr: "ag-references: missing symbol name\n",
        exitCode: 2,
      };
    }

    if (!ctx.bash) {
      return {
        stdout: "",
        stderr: "ag-references: no bash host available\n",
        exitCode: 1,
      };
    }

    const occurrences = ctx.bash.semanticEngine.getOccurrences(name);

    if (occurrences.length === 0) {
      return {
        stdout: `No references found for '${name}'.\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    const refs = occurrences
      .filter((o: any) => !o.isDefinition)
      .map((o: any) => `  - ${o.path}: line ${o.line} (in ${o.scope})`)
      .join("\n");

    const def = occurrences.find((o: any) => o.isDefinition);
    let output = `Found ${occurrences.length} occurrences of '${name}':\n`;
    if (def) output += `Definition: ${def.path}: line ${def.line}\n`;
    if (refs) output += `References:\n${refs}\n`;

    return { stdout: output, stderr: "", exitCode: 0 };
  },
};
