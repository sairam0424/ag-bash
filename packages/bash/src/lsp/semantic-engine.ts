import type { ScriptNode, StatementNode, ASTNode, FunctionDefNode, SimpleCommandNode, AssignmentNode } from "../ast/types.js";

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
 * Levenshtein distance utility for fuzzy matching.
 */
export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1, // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
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

  constructor(private ast?: ScriptNode) {
    if (this.ast) {
      this.analyze();
    }
  }

  /**
   * Refreshes the semantic symbol table by traversing the AST.
   */
  private analyze(): void {
    if (!this.ast) return;
    this.symbols = [];
    this.traverse(this.ast, "global");
  }

  private traverse(node: ASTNode, currentScope: string): void {
    if (!node) return;
    
    switch (node.type) {
      case "Script":
        (node as ScriptNode).statements.forEach(s => this.traverse(s, currentScope));
        break;
      case "Statement":
        (node as StatementNode).pipelines.forEach((p) =>
          p.commands.forEach((c) => this.traverse(c, currentScope)),
        );
        break;
      case "Pipeline":
        (node as any).commands.forEach((c: any) =>
          this.traverse(c, currentScope),
        );
        break;
      case "FunctionDef": {
        const fnNode = node as FunctionDefNode;
        // Avoid duplicate functions in incremental indexing
        if (!this.symbols.some(s => s.name === fnNode.name && s.type === SymbolType.Function)) {
          this.symbols.push({
            name: fnNode.name,
            type: SymbolType.Function,
            line: fnNode.line ?? 0,
            column: 0,
            scope: "global"
          });
        }
        this.traverse(fnNode.body, fnNode.name);
        break;
      }
      case "SimpleCommand": {
        const cmdNode = node as SimpleCommandNode;
        cmdNode.assignments.forEach(a => this.traverse(a, currentScope));
        break;
      }
      case "Assignment": {
        const assignNode = node as AssignmentNode;
        // Avoid duplicate variables in incremental indexing
        if (!this.symbols.some(s => s.name === assignNode.name && s.type === SymbolType.Variable && s.scope === currentScope)) {
          this.symbols.push({
            name: assignNode.name,
            type: SymbolType.Variable,
            line: assignNode.line ?? 0,
            column: 0,
            scope: currentScope
          });
        }
        break;
      }
      case "Group":
        (node as any).body.forEach((s: any) =>
          this.traverse(s, currentScope),
        );
        break;
      case "Subshell":
        (node as any).body.forEach((s: any) =>
          this.traverse(s, currentScope),
        );
        break;
      case "If":
        (node as any).clauses.forEach((c: any) => {
          c.condition.forEach((s: any) => this.traverse(s, currentScope));
          c.body.forEach((s: any) => this.traverse(s, currentScope));
        });
        if ((node as any).elseBody) {
          (node as any).elseBody.forEach((s: any) =>
            this.traverse(s, currentScope),
          );
        }
        break;
      case "While":
      case "Until":
        (node as any).condition.forEach((s: any) =>
          this.traverse(s, currentScope),
        );
        (node as any).body.forEach((s: any) => this.traverse(s, currentScope));
        break;
      case "For":
        (node as any).body.forEach((s: any) => this.traverse(s, currentScope));
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
    return this.symbols.find(s => s.name === name && s.scope === scope) 
      || this.symbols.find(s => s.name === name && s.scope === "global");
  }

  /**
   * Incremental indexer called by the interpreter.
   */
  public indexStatement(node: StatementNode): void {
    this.traverse(node, "global");
  }

  /**
   * Fuzzy search for symbols similar to the query.
   */
  public fuzzySearchSymbols(
    query: string,
    type?: SymbolType,
    maxDistance: number = 2,
  ): SemanticSymbol[] {
    return this.symbols
      .filter((s) => !type || s.type === type)
      .map((s) => ({ symbol: s, distance: levenshtein(query, s.name) }))
      .filter((res) => res.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .map((res) => res.symbol);
  }
}
