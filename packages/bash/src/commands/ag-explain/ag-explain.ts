import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agExplainHelp = {
  name: "ag-explain",
  summary: "parse and explain a shell command",
  usage: "ag-explain <command_string>",
  options: [
    "    --json        output raw AST in JSON format",
    "    --help        display this help and exit",
  ],
};

export const agExplainCommand: Command = {
  name: "ag-explain",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(agExplainHelp);

    const argDefs = {
      json: { long: "json", type: "boolean" as const },
    };

    const parsed = parseArgs("ag-explain", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const { flags, positional } = parsed.result;
    const commandToExplain = positional.join(" ");

    if (!commandToExplain) {
      return { stdout: "", stderr: "ag-explain: missing command string\n", exitCode: 2 };
    }

    try {
      const { parse } = await import("../../parser/parser.js");
      const ast = parse(commandToExplain);

      if (flags.json) {
        return {
          stdout: JSON.stringify(ast, (k, v) => k === "parent" ? undefined : v, 2) + "\n",
          stderr: "",
          exitCode: 0
        };
      }

      let explanation = `--- Explanation for: ${commandToExplain} ---\n`;
      
      const explainNode = (node: any, indent: string = ""): string => {
        let text = "";
        switch (node.type) {
          case "Script":
            node.statements.forEach((s: any) => text += explainNode(s, indent));
            break;
          case "Statement":
            node.pipelines.forEach((p: any) => text += explainNode(p, indent));
            break;
          case "Pipeline":
            if (node.commands.length > 1) {
              text += `${indent}Pipeline with ${node.commands.length} stages:\n`;
              node.commands.forEach((c: any, i: number) => {
                text += `${indent}  [Stage ${i+1}]:\n`;
                text += explainNode(c, indent + "    ");
              });
            } else {
              text += explainNode(node.commands[0], indent);
            }
            break;
          case "SimpleCommand":
            text += `${indent}Execute command: '${node.name?.text || ""}'\n`;
            if (node.args.length > 0) {
              text += `${indent}  Arguments: ${node.args.map((a: any) => `'${a.text}'`).join(", ")}\n`;
            }
            if (node.assignments.length > 0) {
               text += `${indent}  Environment variables: ${node.assignments.map((a: any) => `${a.name}=${a.value?.text || ""}`).join(", ")}\n`;
            }
            if (node.redirects.length > 0) {
              text += `${indent}  Redirections:\n`;
              node.redirects.forEach((r: any) => {
                text += `${indent}    - fd ${r.fd || (r.type.startsWith(">") ? 1 : 0)} ${r.type} ${r.file.text}\n`;
              });
            }
            break;
          case "If":
            text += `${indent}Conditional (if):\n`;
            node.clauses.forEach((c: any, i: number) => {
               text += `${indent}  ${i === 0 ? "Condition" : "Elif condition"}:\n`;
               c.condition.forEach((s: any) => text += explainNode(s, indent + "    "));
               text += `${indent}  Body:\n`;
               c.body.forEach((s: any) => text += explainNode(s, indent + "    "));
            });
            if (node.elseBody) {
               text += `${indent}  Else body:\n`;
               node.elseBody.forEach((s: any) => text += explainNode(s, indent + "    "));
            }
            break;
          default:
            text += `${indent}Node type: ${node.type}\n`;
        }
        return text;
      };

      explanation += explainNode(ast);
      explanation += `--------------------------------------\n`;

      return { stdout: explanation, stderr: "", exitCode: 0 };

    } catch (e: any) {
      return { stdout: "", stderr: `ag-explain: parse error: ${e.message}\n`, exitCode: 1 };
    }
  },
};
