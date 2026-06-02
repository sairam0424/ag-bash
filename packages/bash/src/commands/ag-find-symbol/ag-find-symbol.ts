import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agFindSymbolHelp = {
  name: "ag-find-symbol",
  summary: "search for symbols across the workspace",
  usage: "ag-find-symbol <query>",
  options: ["    --help        display this help and exit"],
};

export const agFindSymbolCommand: Command = {
  name: "ag-find-symbol",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(agFindSymbolHelp);

    const parsed = parseArgs("ag-find-symbol", args, Object.create(null));
    if (!parsed.ok) return parsed.error;

    const { positional } = parsed.result;
    const query = positional[0];

    // Access the global semantic engine via ctx (or via ctx.bash if we expose it)
    // Actually, in Ag-Bash, the indexer is often attached to the Bash instance.
    // Let's assume ctx has access to the workspace engine or we use a service.

    // In our current architecture, the indexer is on the Bash instance.
    // We might need to expose it to the command context.

    if (!ctx.bash) {
      return {
        stdout: "",
        stderr: "ag-find-symbol: no bash host available\n",
        exitCode: 1,
      };
    }

    const symbols = await ctx.bash.indexer.findSymbols(query);

    if (symbols.length === 0) {
      return {
        stdout: `No symbols found matching '${query}'.\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    let output = `Found ${symbols.length} symbols:\n`;
    symbols.forEach((s: any) => {
      output += `  - ${s.name} (${s.type}) in ${s.path} (line ${s.line})\n`;
    });

    return { stdout: output, stderr: "", exitCode: 0 };
  },
};
