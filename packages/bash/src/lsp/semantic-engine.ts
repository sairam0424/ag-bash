import type { ScriptNode, StatementNode, ASTNode, FunctionDefNode, SimpleCommandNode, AssignmentNode, WordNode, ParameterExpansionPart } from "../ast/types.js";

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
  path?: string; // File path for workspace-wide indexing
}

/**
 * An occurrence of a symbol (either a definition or a reference).
 */
export interface SymbolOccurrence {
  name: string;
  type: SymbolType;
  line: number;
  column: number;
  isDefinition: boolean;
  scope: string;
  path?: string; // File path for workspace-wide indexing
}

/**
 * Semantic Engine for Ag-Bash.
 * 
 * Analyzes ASTs to provide semantic intelligence for shell scripts.
 */
export class SemanticEngine {
  private symbols: SemanticSymbol[] = [];
  private occurrences: SymbolOccurrence[] = [];

  constructor(private ast: ScriptNode | undefined = undefined) {
    if (this.ast) {
      this.analyze();
    }
  }

  /**
   * Refreshes the semantic symbol table by traversing the AST.
   */
  public analyze(path?: string): void {
    if (!this.ast) return;
    this.symbols = [];
    this.occurrences = [];
    this.traverse(this.ast, "global", path);
  }

  private traverse(node: ASTNode, currentScope: string, path?: string): void {
    if (!node) return;
    
    switch (node.type) {
      case "Script":
        (node as ScriptNode).statements.forEach(s => this.traverse(s, currentScope, path));
        break;
      case "Statement":
        (node as StatementNode).pipelines.forEach((p) =>
          p.commands.forEach((c) => this.traverse(c, currentScope, path)),
        );
        break;
      case "Pipeline":
        (node as any).commands.forEach((c: any) =>
          this.traverse(c, currentScope, path),
        );
        break;
      case "FunctionDef": {
        const fnNode = node as FunctionDefNode;
        const occ: SymbolOccurrence = {
          name: fnNode.name,
          type: SymbolType.Function,
          line: fnNode.line ?? 0,
          column: 0,
          isDefinition: true,
          scope: "global",
          path
        };
        this.occurrences.push(occ);

        if (!this.symbols.some(s => s.name === fnNode.name && s.type === SymbolType.Function && s.path === path)) {
          this.symbols.push({
            name: fnNode.name,
            type: SymbolType.Function,
            line: fnNode.line ?? 0,
            column: 0,
            scope: "global",
            path
          });
        }
        this.traverse(fnNode.body, fnNode.name, path);
        break;
      }
      case "SimpleCommand": {
        const cmdNode = node as SimpleCommandNode;
        cmdNode.assignments.forEach(a => this.traverse(a, currentScope, path));
        
        // Track function calls as references
        if (cmdNode.name && cmdNode.name.parts.length === 1 && cmdNode.name.parts[0].type === "Literal") {
          const name = (cmdNode.name.parts[0] as any).value;
          this.occurrences.push({
            name,
            type: SymbolType.Function,
            line: cmdNode.line ?? 0,
            column: 0,
            isDefinition: false,
            scope: currentScope,
            path
          });
        }
        
        cmdNode.args.forEach(arg => this.traverse(arg, currentScope, path));
        break;
      }
      case "Assignment": {
        const assignNode = node as AssignmentNode;
        const occ: SymbolOccurrence = {
          name: assignNode.name,
          type: SymbolType.Variable,
          line: assignNode.line ?? 0,
          column: 0,
          isDefinition: true,
          scope: currentScope,
          path
        };
        this.occurrences.push(occ);

        if (!this.symbols.some(s => s.name === assignNode.name && s.type === SymbolType.Variable && s.scope === currentScope && s.path === path)) {
          this.symbols.push({
            name: assignNode.name,
            type: SymbolType.Variable,
            line: assignNode.line ?? 0,
            column: 0,
            scope: currentScope,
            path
          });
        }
        if (assignNode.value) {
          this.traverse(assignNode.value, currentScope, path);
        }
        break;
      }
      case "Word": {
        const wordNode = node as WordNode;
        wordNode.parts.forEach(p => this.traverse(p, currentScope, path));
        break;
      }
      case "ParameterExpansion": {
        const peNode = node as ParameterExpansionPart;
        this.occurrences.push({
          name: peNode.parameter,
          type: SymbolType.Variable,
          line: peNode.line ?? 0,
          column: 0,
          isDefinition: false,
          scope: currentScope,
          path
        });
        break;
      }
      case "DoubleQuoted": {
        (node as any).parts.forEach((p: any) => this.traverse(p, currentScope, path));
        break;
      }
      case "Group":
        (node as any).body.forEach((s: any) =>
          this.traverse(s, currentScope, path),
        );
        break;
      case "Subshell":
        (node as any).body.forEach((s: any) =>
          this.traverse(s, currentScope, path),
        );
        break;
      case "If":
        (node as any).clauses.forEach((c: any) => {
          c.condition.forEach((s: any) => this.traverse(s, currentScope, path));
          c.body.forEach((s: any) => this.traverse(s, currentScope, path));
        });
        if ((node as any).elseBody) {
          (node as any).elseBody.forEach((s: any) =>
            this.traverse(s, currentScope, path),
          );
        }
        break;
      case "While":
      case "Until":
        (node as any).condition.forEach((s: any) =>
          this.traverse(s, currentScope, path),
        );
        (node as any).body.forEach((s: any) => this.traverse(s, currentScope, path));
        break;
      case "For": {
        const forNode = node as any;
        // The for loop variable is a definition
        this.occurrences.push({
          name: forNode.variable,
          type: SymbolType.Variable,
          line: forNode.line ?? 0,
          column: 0,
          isDefinition: true,
          scope: currentScope,
          path
        });
        if (forNode.words) {
          forNode.words.forEach((w: any) => this.traverse(w, currentScope, path));
        }
        forNode.body.forEach((s: any) => this.traverse(s, currentScope, path));
        break;
      }
    }
  }

  /**
   * Returns all symbols visible from a specific scope.
   */
  public getVisibleSymbols(scope: string = "global"): SemanticSymbol[] {
    return this.symbols.filter(s => s.scope === "global" || s.scope === scope);
  }

  /**
   * Returns all indexed symbols.
   */
  public getAllSymbols(): SemanticSymbol[] {
    return this.symbols;
  }

  /**
   * Returns all occurrences of a symbol.
   */
  public getOccurrences(name: string): SymbolOccurrence[] {
    return this.occurrences.filter(o => o.name === name);
  }

  /**
   * Resolves a symbol's definition.
   */
  public findDefinition(name: string, scope: string = "global"): SemanticSymbol | undefined {
    return this.symbols.find(s => s.name === name && s.scope === scope) 
      || this.symbols.find(s => s.name === name && s.scope === "global");
  }

  /**
   * Incremental indexer called by the interpreter or workspace indexer.
   */
  public indexNode(node: ASTNode, path?: string): void {
    this.traverse(node, "global", path);
  }

  public async indexStatement(node: StatementNode, path?: string): Promise<void> {
    this.traverse(node, "global", path);
  }

  public async indexScript(node: ScriptNode, path?: string): Promise<void> {
    this.traverse(node, "global", path);
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

  /**
   * Serializes the current symbol table and occurrences.
   */
  public serialize(): string {
    return JSON.stringify({
      symbols: this.symbols,
      occurrences: this.occurrences
    });
  }

  /**
   * Deserializes symbols and occurrences into the engine.
   */
  public deserialize(data: string | object): void {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    if (parsed.symbols) this.symbols = parsed.symbols;
    if (parsed.occurrences) this.occurrences = parsed.occurrences;
  }

  /**
   * Merges another set of symbols into the current index.
   * Useful for incremental workspace indexing.
   */
  public merge(other: { symbols: SemanticSymbol[], occurrences: SymbolOccurrence[] }): void {
    // Basic deduplication based on name, type, scope and path
    for (const s of other.symbols) {
      if (!this.symbols.some(existing => 
        existing.name === s.name && 
        existing.type === s.type && 
        existing.scope === s.scope &&
        existing.path === s.path
      )) {
        this.symbols.push(s);
      }
    }
    // Occurrences are generally unique by location
    for (const o of other.occurrences) {
      if (!this.occurrences.some(existing =>
        existing.name === o.name &&
        existing.line === o.line &&
        existing.column === o.column &&
        existing.path === o.path
      )) {
        this.occurrences.push(o);
      }
    }
  }

  /**
   * Removes all symbols associated with a specific path.
   * Used for incremental updates when a file is modified.
   */
  public clearPath(path: string): void {
    this.symbols = this.symbols.filter(s => s.path !== path);
    this.occurrences = this.occurrences.filter(o => o.path !== path);
  }
}
