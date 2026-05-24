/**
 * ParseStage - Parser selection, AST generation, and cache lookup/store.
 *
 * Handles:
 * - Tree-sitter pre-initialization (outside sandbox)
 * - AST cache lookup
 * - Legacy parser vs tree-sitter parser selection
 * - AST cache storage
 */

import type { ScriptNode } from "../../ast/types.js";
import type { ExecutionLimits } from "../../limits.js";
import { parse } from "../../parser/parser.js";
import { TreeSitterParser } from "../../parser/tree-sitter-parser.js";
import { TreeSitterToAst } from "../../parser/tree-sitter-to-ast.js";
import type { PipelineContext, PipelineStage, StageResult } from "../types.js";

export class ParseStage implements PipelineStage {
  readonly name = "parse";

  private readonly parserEngine: "legacy" | "tree-sitter";
  private readonly treeSitterConfig?: {
    webTreeSitterWasm: string | Uint8Array;
    bashGrammarWasm?: string | Uint8Array;
    grammars?: Record<string, string | Uint8Array>;
  };
  private readonly limits: Required<ExecutionLimits>;

  constructor(opts: {
    parserEngine: "legacy" | "tree-sitter";
    treeSitterConfig?: {
      webTreeSitterWasm: string | Uint8Array;
      bashGrammarWasm?: string | Uint8Array;
      grammars?: Record<string, string | Uint8Array>;
    };
    limits: Required<ExecutionLimits>;
  }) {
    this.parserEngine = opts.parserEngine;
    this.treeSitterConfig = opts.treeSitterConfig;
    this.limits = opts.limits;
  }

  async execute(context: PipelineContext): Promise<StageResult> {
    const { normalizedScript, services } = context;

    // Pre-initialize Tree-sitter outside of the defense-in-depth sandbox
    // because its WASM/JS glue code uses dynamic imports that are blocked
    // during sandboxed script execution.
    if (this.parserEngine === "tree-sitter" && this.treeSitterConfig) {
      const grammars: Record<string, string | Uint8Array> = Object.assign(
        Object.create(null),
        this.treeSitterConfig.grammars,
      );
      if (this.treeSitterConfig.bashGrammarWasm) {
        grammars.bash = this.treeSitterConfig.bashGrammarWasm;
      }
      await TreeSitterParser.init({
        webTreeSitterWasm: this.treeSitterConfig.webTreeSitterWasm,
        grammars,
      });
    }

    // AST cache lookup
    const astCache = services.astCache;
    const cachedAst = astCache.get(normalizedScript);
    if (cachedAst) {
      context.ast = cachedAst;
      return { continue: true, context };
    }

    // Parse
    let ast: ScriptNode;
    if (this.parserEngine === "tree-sitter" && this.treeSitterConfig) {
      const tree = TreeSitterParser.parse(normalizedScript);
      const converter = new TreeSitterToAst(normalizedScript);
      ast = converter.convert(tree);
    } else {
      ast = parse(normalizedScript, {
        maxHeredocSize: this.limits.maxHeredocSize,
      }) as ScriptNode;
    }

    // Store in cache
    astCache.set(normalizedScript, ast);
    context.ast = ast;

    return { continue: true, context };
  }
}
