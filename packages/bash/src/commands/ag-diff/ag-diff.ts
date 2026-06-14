import * as Diff from "diff";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agDiffHelp = {
  name: "ag-diff",
  summary: "agent-optimized file comparison with change summaries",
  usage: "ag-diff [OPTION]... FILE1 FILE2",
  options: [
    "-u, --unified     output unified diff format (default)",
    "-s, --summary     output only a summary of changes",
    "-i, --ignore-case  ignore case differences",
    "    --help        display this help and exit",
  ],
};

const argDefs = {
  unified: { short: "u", long: "unified", type: "boolean" as const },
  summary: { short: "s", long: "summary", type: "boolean" as const },
  ignoreCase: { short: "i", long: "ignore-case", type: "boolean" as const },
};

export const agDiffCommand: Command = {
  name: "ag-diff",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(agDiffHelp);

    const parsed = parseArgs("ag-diff", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const showSummary = parsed.result.flags.summary;
    const ignoreCase = parsed.result.flags.ignoreCase;
    const files = parsed.result.positional;

    if (files.length < 2) {
      return { stdout: "", stderr: "ag-diff: missing operand\n", exitCode: 2 };
    }

    const [f1, f2] = files;
    let c1: string, c2: string;

    try {
      c1 =
        f1 === "-"
          ? ctx.stdin
          : await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, f1));
    } catch {
      return {
        stdout: "",
        stderr: `ag-diff: ${f1}: No such file or directory\n`,
        exitCode: 2,
      };
    }

    try {
      c2 =
        f2 === "-"
          ? ctx.stdin
          : await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, f2));
    } catch {
      return {
        stdout: "",
        stderr: `ag-diff: ${f2}: No such file or directory\n`,
        exitCode: 2,
      };
    }

    if (ignoreCase) {
      c1 = c1.toLowerCase();
      c2 = c2.toLowerCase();
    }

    const diff = Diff.structuredPatch(f1, f2, c1, c2, "", "", { context: 3 });

    let added = 0;
    let removed = 0;
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) added++;
        if (line.startsWith("-")) removed++;
      }
    }

    if (showSummary) {
      return {
        stdout: `Summary: ${added} additions, ${removed} deletions in ${f2} compared to ${f1}\n`,
        stderr: "",
        exitCode: added + removed > 0 ? 1 : 0,
      };
    }

    const output = Diff.createTwoFilesPatch(f1, f2, c1, c2, "", "", {
      context: 3,
    });
    const fullOutput = `--- ag-diff summary ---\n${f1} -> ${f2}\nAdditions: ${added}, Deletions: ${removed}\n-----------------------\n\n${output}\n`;

    return {
      stdout: fullOutput,
      stderr: "",
      exitCode: added + removed > 0 ? 1 : 0,
    };
  },
};
