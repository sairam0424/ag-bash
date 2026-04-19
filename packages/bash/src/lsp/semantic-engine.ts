import type { ScriptNode, StatementNode, ASTNode, FunctionDefNode, SimpleCommandNode, AssignmentNode, ParameterExpansionPart } from "../ast/types.js";

/**
 * Semantic symbol type for bash scripts.
 */
export enum SymbolType {
  Variable = "Variable",
  Function = "Function",
  Command = "Command",
  File = "File",
}

/**
 * A semantic symbol found in the script.
 */
export interface SemanticSymbol {
  name: string;
  type: SymbolType;
  line: number;
  column: number;
  scope: string; // "global" | functionName
}

/**
 * Semantic Engine for Ag-Bash.
 * 
 * Analyzes ASTs to provide semantic intelligence for shell scripts.
 */
export class SemanticEngine {
  private symbols: SemanticSymbol[] = [];

  constructor(private ast: ScriptNode) {
    this.analyze();
  }

  /**
   * Refreshes the semantic symbol table by traversing the AST.
   */
  private analyze(): void {
    this.symbols = [];
    this.traverse(this.ast, "global");
  }

  private traverse(node: ASTNode, currentScope: string): void {
    switch (node.type) {
      case "Script":
        (node as ScriptNode).statements.forEach(s => this.traverse(s, currentScope));
        break;
      case "Statement":
        (node as StatementNode).pipelines.forEach(p => p.commands.forEach(c => this.traverse(c, currentScope)));
        break;
      case "FunctionDef": {
        const fnNode = node as FunctionDefNode;
        this.symbols.push({
          name: fnNode.name,
          type: SymbolType.Function,
          line: fnNode.line ?? 0,
          column: 0,
          scope: "global"
        });
        this.traverse(fnNode.body, fnNode.name);
        break;
      }
      case "SimpleCommand": {
        const cmdNode = node as SimpleCommandNode;
        cmdNode.assignments.forEach(a => this.traverse(a, currentScope));
        // Command names are technically symbols but often external
        break;
      }
      case "Assignment": {
        const assignNode = node as AssignmentNode;
        this.symbols.push({
          name: assignNode.name,
          type: SymbolType.Variable,
          line: assignNode.line ?? 0,
          column: 0,
          scope: currentScope
        });
        break;
      }
      case "Group":
      case "Subshell":
      case "If":
      case "While":
      case "Until":
      case "For":
      // Control flow nodes often contain StatementNode[] or CompoundCommand
      // Recursion logic for these would be added here to find nested assignments
      break;
    }
  }

  /**
   * Returns all symbols visible from a specific scope.
   */
  public getVisibleSymbols(scope: string = "global"): SemanticSymbol[] {
    return this.symbols.filter(s => s.scope === "global" || s.scope === scope);
  }

  /**
   * Resolves a symbol's definition.
   */
  public findDefinition(name: string, scope: string = "global"): SemanticSymbol | undefined {
    // Search local scope first, then global
    return this.symbols.find(s => s.name === name && s.scope === scope) 
      || this.symbols.find(s => s.name === name && s.scope === "global");
  }

  /**
   * Incremental indexer called by the interpreter.
   */
  public indexStatement(node: StatementNode): void {
    this.traverse(node, "global");
  }
}
