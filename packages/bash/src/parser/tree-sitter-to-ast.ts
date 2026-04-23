import Parser, { type Node, type Tree } from "web-tree-sitter";
import {
  AST,
  type AssignmentNode,
  type CaseItemNode,
  type CommandNode,
  type CompoundCommandNode,
  type IfClause,
  type PipelineNode,
  type RedirectionNode,
  type ScriptNode,
  type StatementNode,
  type WordNode,
  type WordPart,
} from "../ast/types.js";

/**
 * TreeSitterToAst converts a Tree-sitter CST into the internal Ag-Bash AST.
 * Handles node mapping, source location tracking, and bash-specific syntax quirks.
 */
export class TreeSitterToAst {
  private source: string;

  constructor(source: string) {
    this.source = source;
  }

  /**
   * Convert a complete Tree-sitter tree to a ScriptNode.
   */
  convert(tree: Tree): ScriptNode {
    return {
      type: "Script",
      statements: this.convertProgram(tree.rootNode),
      line: 1,
    };
  }

  private convertProgram(node: Node): StatementNode[] {
    const statements: StatementNode[] = [];
    for (const child of node.namedChildren) {
      const stmt = this.convertElementToStatement(child);
      if (stmt) statements.push(stmt);
    }
    return statements;
  }

  /**
   * Tree-sitter bash often returns nodes that represent multiple pipelines (a 'list').
   * This helper ensures they are always wrapped in our StatementNode structure.
   */
  private convertElementToStatement(node: Node): StatementNode | null {
    if (node.type === "list" || node.type === "compound_list") {
      return this.convertListNode(node);
    }

    const pipeline = this.convertNodeToPipeline(node);
    if (!pipeline) return null;

    return {
      type: "Statement",
      pipelines: [pipeline],
      operators: [],
      background: node.type === "last_background_command", // Tree-sitter quirk
      line: node.startPosition.row + 1,
    };
  }

  private convertListNode(node: Node): StatementNode {
    const pipelines: PipelineNode[] = [];
    const operators: ("&&" | "||" | ";")[] = [];
    let background = false;

    for (const child of node.children) {
      if (child.isNamed) {
        const pipeline = this.convertNodeToPipeline(child);
        if (pipeline) pipelines.push(pipeline);
      } else {
        const text = child.type;
        if (text === "&&" || text === "||" || text === ";") {
          operators.push(text as "&&" | "||" | ";");
        } else if (text === "&") {
          background = true;
        }
      }
    }

    return {
      type: "Statement",
      pipelines,
      operators,
      background,
      line: node.startPosition.row + 1,
    };
  }

  private convertNodeToPipeline(node: Node): PipelineNode | null {
    if (node.type === "pipeline") {
      const commands: CommandNode[] = [];
      const pipeStderr: boolean[] = [];

      for (const child of node.namedChildren) {
        const cmd = this.convertCommand(child);
        if (cmd) commands.push(cmd);
      }

      // Check for |& (pipe stderr)
      for (const child of node.children) {
        if (!child.isNamed && child.type === "|&") {
          pipeStderr.push(true);
        } else if (!child.isNamed && child.type === "|") {
          pipeStderr.push(false);
        }
      }

      return {
        type: "Pipeline",
        commands,
        negated: false,
        pipeStderr: pipeStderr.length > 0 ? pipeStderr : undefined,
        line: node.startPosition.row + 1,
      };
    }

    if (node.type === "negated_command") {
      const inner = this.convertNodeToPipeline(node.namedChildren[0]);
      if (inner) {
        inner.negated = true;
        return inner;
      }
      return null;
    }

    const cmd = this.convertCommand(node);
    if (cmd) {
      return {
        type: "Pipeline",
        commands: [cmd],
        negated: false,
        line: node.startPosition.row + 1,
      };
    }

    return null;
  }

  private convertCommand(node: Node): CommandNode | null {
    switch (node.type) {
      case "command":
        return this.convertSimpleCommand(node);
      case "if_statement":
        return this.convertIfStatement(node);
      case "for_statement":
        return this.convertForStatement(node);
      case "while_statement":
        return this.convertWhileUntilStatement(node, "While");
      case "until_statement":
        return this.convertWhileUntilStatement(node, "Until");
      case "case_statement":
        return this.convertCaseStatement(node);
      case "function_definition":
        return this.convertFunctionDefinition(node);
      case "subshell":
        return this.convertSubshell(node);
      case "compound_statement":
        return this.convertGroup(node);
      case "variable_assignment": {
        const assignment = this.convertAssignment(node);
        return {
          type: "SimpleCommand",
          assignments: [assignment],
          name: null,
          args: [],
          redirections: [],
          line: node.startPosition.row + 1,
        };
      }
      case "subscript":
        return null;
      case "redirected_statement": {
        const inner = this.convertCommand(node.namedChild(0)!);
        if (inner) {
          const redirects = this.convertRedirections(node);
          inner.redirections.push(...redirects);
          return inner;
        }
        return null;
      }
      case "test_command":
        return this.convertConditionalCommand(node);
      case "declaration_command":
        return this.convertSimpleCommand(node);
      default:
        return null;
    }
  }

  private convertSimpleCommand(node: Node): CommandNode {
    const assignments: AssignmentNode[] = [];
    let name: WordNode | null = null;
    const args: WordNode[] = [];
    const redirections: RedirectionNode[] = [];

    for (const child of node.namedChildren) {
      if (child.type === "variable_assignment") {
        assignments.push(this.convertAssignment(child));
      } else if (
        child.type === "file_redirect" ||
        child.type === "heredoc_redirect" ||
        child.type === "herestring_redirect"
      ) {
        redirections.push(this.convertRedirection(child));
      } else if (child.type === "command_name") {
        name = this.convertWord(child);
      } else if (
        child.type === "word" ||
        child.type === "string" ||
        child.type === "raw_string" ||
        child.type === "concatenation"
      ) {
        args.push(this.convertWord(child));
      }
    }

    return {
      type: "SimpleCommand",
      assignments,
      name,
      args,
      redirections,
      line: node.startPosition.row + 1,
    };
  }

  private convertAssignment(node: Node): AssignmentNode {
    const nameNode = node.childForFieldName("name") || node.namedChild(0);
    const valueNode =
      node.childForFieldName("value") ||
      (node.namedChild(1)?.type === "="
        ? node.namedChild(2)
        : node.namedChild(1));

    return {
      type: "Assignment",
      name: nameNode ? nameNode.text : "unknown",
      value: valueNode ? this.convertWord(valueNode) : null,
      append: node.text.includes("+="),
      array: null,
      line: node.startPosition.row + 1,
    };
  }

  private convertRedirections(node: Node): RedirectionNode[] {
    const redirects: RedirectionNode[] = [];
    for (const child of node.namedChildren) {
      if (child.type.includes("redirect")) {
        redirects.push(this.convertRedirection(child));
      }
    }
    return redirects;
  }

  private convertRedirection(node: Node): RedirectionNode {
    const fdNode = node.childForFieldName("descriptor");
    const destNode =
      node.childForFieldName("destination") || node.childForFieldName("body");

    let operator: any = ">";
    if (node.type === "heredoc_redirect") {
      operator = node.text.includes("<<-") ? "<<-" : "<<";
    } else if (node.type === "herestring_redirect") {
      operator = "<<<";
    } else {
      const opMatch = node.text.match(/[<>&|]+/);
      if (opMatch) operator = opMatch[0];
    }

    let target: any;
    if (node.type === "heredoc_redirect") {
      target = this.convertHeredoc(node);
    } else if (destNode) {
      target = this.convertWord(destNode);
    } else {
      target = AST.word([]);
    }

    return {
      type: "Redirection",
      fd: fdNode ? parseInt(fdNode.text) : null,
      operator,
      target,
      line: node.startPosition.row + 1,
    };
  }

  private convertHeredoc(node: Node): any {
    const startNode = node.namedChild(0)!; // heredoc_start
    const bodyNode = node.namedChild(1)!; // heredoc_body

    const delimiter = startNode.text.replace(/^[<-]+/, "").trim();
    const quoted = startNode.text.includes("'") || startNode.text.includes('"');

    return {
      type: "HereDoc",
      delimiter,
      content: this.convertWord(bodyNode),
      stripTabs: startNode.text.includes("<<-"),
      quoted,
      line: node.startPosition.row + 1,
    };
  }

  private convertWord(node: Node): WordNode {
    const parts: WordPart[] = [];

    if (node.type === "word" || node.type === "command_name") {
      if (node.namedChildCount === 0) {
        parts.push({
          type: "Literal",
          value: node.text,
          line: node.startPosition.row + 1,
        });
      } else {
        for (const child of node.namedChildren) {
          const part = this.convertWordPart(child);
          if (part) parts.push(part);
        }
      }
    } else if (node.type === "concatenation") {
      for (const child of node.namedChildren) {
        const part = this.convertWordPart(child);
        if (part) parts.push(part);
      }
    } else {
      const part = this.convertWordPart(node);
      if (part) parts.push(part);
    }

    return {
      type: "Word",
      parts,
      line: node.startPosition.row + 1,
    };
  }

  private convertWordPart(node: Node): WordPart | null {
    switch (node.type) {
      case "string":
      case "raw_string":
      case "ansi_c_string":
        return this.convertString(node);
      case "simple_expansion":
      case "expansion":
        return this.convertExpansion(node);
      case "command_substitution":
        return {
          type: "CommandSubstitution",
          body: {
            type: "Script",
            statements: this.convertList(node),
            line: node.startPosition.row + 1,
          },
          legacy: node.text.startsWith("`"),
          line: node.startPosition.row + 1,
        };
      case "word":
        return {
          type: "Literal",
          value: node.text,
          line: node.startPosition.row + 1,
        };
      default:
        return {
          type: "Literal",
          value: node.text,
          line: node.startPosition.row + 1,
        };
    }
  }

  private convertString(node: Node): WordPart {
    const isSingle = node.type === "raw_string";
    if (isSingle) {
      return {
        type: "SingleQuoted",
        value: node.text.slice(1, -1),
        line: node.startPosition.row + 1,
      };
    }

    const parts: WordPart[] = [];
    for (const child of node.namedChildren) {
      const part = this.convertWordPart(child);
      if (part) parts.push(part);
    }

    if (parts.length === 0 && node.text.length > 2) {
      parts.push({
        type: "Literal",
        value: node.text.slice(1, -1),
        line: node.startPosition.row + 1,
      });
    }

    return {
      type: "DoubleQuoted",
      parts,
      line: node.startPosition.row + 1,
    };
  }

  private convertExpansion(node: Node): WordPart {
    const name = node.text.replace(/^\${?/, "").replace(/}?$/, "");

    return {
      type: "ParameterExpansion",
      parameter: name,
      operation: null,
      line: node.startPosition.row + 1,
    };
  }

  private convertIfStatement(node: Node): CompoundCommandNode {
    const clauses: IfClause[] = [];
    let elseBody: StatementNode[] | null = null;

    const conditionNode =
      node.childForFieldName("condition") || node.namedChild(0);
    const consequentNode =
      node.childForFieldName("consequent") || node.namedChild(1);

    if (conditionNode && consequentNode) {
      clauses.push({
        condition: this.convertList(conditionNode),
        body: this.convertList(consequentNode),
      });
    }

    for (const child of node.namedChildren) {
      if (child.type === "elif_clause") {
        const elifCond = child.childForFieldName("condition")!;
        const elifConseq = child.childForFieldName("consequent")!;
        clauses.push({
          condition: this.convertList(elifCond),
          body: this.convertList(elifConseq),
        });
      } else if (child.type === "else_clause") {
        const elseBodyNode = child.namedChild(0)!; // Usually body
        elseBody = this.convertList(elseBodyNode);
      }
    }

    return {
      type: "If",
      clauses,
      elseBody,
      redirections: [], // Control structure level redirections are handled by redirected_statement
      line: node.startPosition.row + 1,
    };
  }

  private convertForStatement(node: Node): CommandNode | null {
    const variable = node.childForFieldName("variable")!.text;
    const valueNode = node.childForFieldName("value");
    const bodyNode = node.childForFieldName("body")!;

    let words: WordNode[] | null = null;
    if (valueNode) {
      words = [];
      for (const child of valueNode.namedChildren) {
        words.push(this.convertWord(child));
      }
    }

    return {
      type: "For",
      variable,
      words,
      body: this.convertList(bodyNode),
      redirections: [],
      line: node.startPosition.row + 1,
    };
  }

  private convertWhileUntilStatement(
    node: Node,
    type: "While" | "Until",
  ): CommandNode | null {
    const conditionNode = node.childForFieldName("condition")!;
    const bodyNode = node.childForFieldName("body")!;

    return {
      type,
      condition: this.convertList(conditionNode),
      body: this.convertList(bodyNode),
      redirections: [],
      line: node.startPosition.row + 1,
    } as any;
  }

  private convertCaseStatement(node: Node): CommandNode | null {
    const valueNode = node.childForFieldName("value")!;
    const items: CaseItemNode[] = [];

    for (const child of node.namedChildren) {
      if (child.type === "case_item") {
        const patternNode = child.childForFieldName("value")!; // TS matches multiple patterns in one word or separate?
        const bodyNode = child.childForFieldName("body")!;

        const patterns: WordNode[] = [];
        // Handle multiple patterns separated by |
        for (const p of child.children) {
          if (
            p.isNamed &&
            (p.type === "word" ||
              p.type === "string" ||
              p.type === "concatenation")
          ) {
            patterns.push(this.convertWord(p));
          }
        }

        items.push({
          type: "CaseItem",
          patterns,
          body: this.convertList(bodyNode),
          terminator: ";;", // TODO: extract from CST
          line: child.startPosition.row + 1,
        });
      }
    }

    return {
      type: "Case",
      word: this.convertWord(valueNode),
      items,
      redirections: [],
      line: node.startPosition.row + 1,
    };
  }

  private convertFunctionDefinition(node: Node): CommandNode | null {
    const nameNode = node.childForFieldName("name")!;
    const bodyNode = node.childForFieldName("body")!;

    return {
      type: "FunctionDef",
      name: nameNode.text,
      body: this.convertCommand(bodyNode) as CompoundCommandNode,
      redirections: [],
      line: node.startPosition.row + 1,
    };
  }

  private convertSubshell(node: Node): CommandNode | null {
    const bodyNode = node.namedChild(0)!;
    return {
      type: "Subshell",
      body: this.convertList(bodyNode),
      redirections: [],
      line: node.startPosition.row + 1,
    };
  }

  private convertGroup(node: Node): CommandNode | null {
    const bodyNode = node.namedChild(0)!;
    return {
      type: "Group",
      body: this.convertList(bodyNode),
      redirections: [],
      line: node.startPosition.row + 1,
    };
  }

  private convertConditionalCommand(node: Node): CommandNode | null {
    // [[ ... ]]
    // Simplified for now, just capturing the text for the expander/interpreter
    // In a real implementation we might want a full CondNode tree
    return null;
  }

  private convertList(node: Node | null): StatementNode[] {
    if (!node) return [];
    if (node.type === "list" || node.type === "compound_list") {
      return this.convertProgram(node);
    }
    const stmt = this.convertElementToStatement(node);
    return stmt ? [stmt] : [];
  }
}
