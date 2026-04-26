import type { Command, CommandContext, ExecResult } from "../../types.js";
import { showHelp } from "../help.js";

const agExplainHelp = {
  name: "ag-explain",
  summary: "parse and explain a shell command",
  usage: "ag-explain [--json] <command_string>",
  options: [
    "    --json        output raw AST in JSON format",
    "    --help        display this help and exit",
  ],
};

export const agExplainCommand: Command = {
  name: "ag-explain",

  async execute(args: string[], _ctx: CommandContext): Promise<ExecResult> {
    if (args.includes("--help") || args.includes("-h"))
      return showHelp(agExplainHelp);

    let useJson = false;
    const commandArgs: string[] = [];

    for (const arg of args) {
      if (arg === "--json") {
        useJson = true;
      } else {
        commandArgs.push(arg);
      }
    }

    const commandToExplain = commandArgs.join(" ");

    if (!commandToExplain) {
      return {
        stdout: "",
        stderr: "ag-explain: missing command string\n",
        exitCode: 2,
      };
    }

    try {
      const { parse } = await import("../../parser/parser.js");
      const ast = parse(commandToExplain);

      if (useJson) {
        return {
          stdout:
            JSON.stringify(ast, (k, v) => (k === "parent" ? undefined : v), 2) +
            "\n",
          stderr: "",
          exitCode: 0,
        };
      }

      let explanation = `--- Explanation for: ${commandToExplain} ---\n`;

      const explainNode = (node: any, indent: string = ""): string => {
        let text = "";
        if (!node) return "";
        try {
          switch (node.type) {
            case "Script":
              if (node.statements)
                node.statements.forEach(
                  (s: any) => (text += explainNode(s, indent)),
                );
              break;
            case "Statement":
              if (node.pipelines)
                node.pipelines.forEach(
                  (p: any) => (text += explainNode(p, indent)),
                );
              break;
            case "Pipeline":
              if (node.commands && node.commands.length > 1) {
                text += `${indent}Pipeline with ${node.commands.length} stages:\n`;
                node.commands.forEach((c: any, i: number) => {
                  text += `${indent}  [Stage ${i + 1}]:\n`;
                  text += explainNode(c, `${indent}    `);
                });
              } else if (node.commands && node.commands.length === 1) {
                text += explainNode(node.commands[0], indent);
              }
              break;
            case "SimpleCommand":
              text += `${indent}Execute command: '${node.name?.text || ""}'\n`;
              if (node.args && node.args.length > 0) {
                text += `${indent}  Arguments: ${node.args.map((a: any) => `'${a.text}'`).join(", ")}\n`;
              }
              if (node.assignments && node.assignments.length > 0) {
                text += `${indent}  Environment variables: ${node.assignments.map((a: any) => `${a.name}=${a.value?.text || ""}`).join(", ")}\n`;
              }
              if (node.redirects && node.redirects.length > 0) {
                text += `${indent}  Redirections:\n`;
                node.redirects.forEach((r: any) => {
                  text += `${indent}    - fd ${r.fd || (r.type.startsWith(">") ? 1 : 0)} ${r.type} ${r.file?.text || "unknown"}\n`;
                });
              }
              break;
            default:
              text += `${indent}Node type: ${node.type}\n`;
          }
        } catch (e: any) {
          text += `${indent}[Error explaining ${node.type}: ${e.message}]\n`;
        }
        return text;
      };

      explanation += explainNode(ast);
      explanation += `--------------------------------------\n`;

      return { stdout: explanation, stderr: "", exitCode: 0 };
    } catch (e: any) {
      return {
        stdout: "",
        stderr: `ag-explain: parse error: ${e.message}\n`,
        exitCode: 1,
      };
    }
  },
};
