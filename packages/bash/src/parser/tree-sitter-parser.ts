// @ts-ignore - Importing from vendored file
import * as TreeSitter from './vendor/web-tree-sitter.js';

/**
 * TreeSitterParser handles WASM initialization and parser instantiation
 * for the v2.9 AST-based transition.
 */
export class TreeSitterParser {
  private static parser: any = null;
  private static language: any = null;
  private static isInitializing = false;

  static async init(options: {
    webTreeSitterWasm: string | Uint8Array;
    bashGrammarWasm: string | Uint8Array;
  }): Promise<void> {
    if (this.parser && this.language) return;
    
    if (this.isInitializing) {
      while (this.isInitializing) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return;
    }

    this.isInitializing = true;
    try {
      console.log("[TreeSitterParser] Initializing with vendored library...");
      const { Parser, Language } = TreeSitter as any;
      
      if (!Parser) {
        throw new Error("Parser class not found in vendored web-tree-sitter module.");
      }

      const initOptions: any = {};
      if (options.webTreeSitterWasm instanceof Uint8Array || Buffer.isBuffer(options.webTreeSitterWasm)) {
        initOptions.wasmBinary = options.webTreeSitterWasm;
      } else {
        initOptions.locateFile = (scriptName: string) => {
          if (scriptName === 'web-tree-sitter.wasm') {
            return options.webTreeSitterWasm as string;
          }
          return scriptName;
        };
      }

      await Parser.init(initOptions);

      this.parser = new Parser();
      
      if (!Language) {
        throw new Error("Language class not found in vendored web-tree-sitter module.");
      }

      // Ensure we pass a Uint8Array to Language.load to avoid path-vs-binary confusion
      const grammarWasm = options.bashGrammarWasm instanceof Uint8Array 
        ? options.bashGrammarWasm 
        : (typeof options.bashGrammarWasm === 'string' ? options.bashGrammarWasm : new Uint8Array(options.bashGrammarWasm as any));

      this.language = await Language.load(grammarWasm);
      this.parser.setLanguage(this.language);
    } catch (e) {
      this.isInitializing = false;
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error("[TreeSitterParser] Initialization FAILED:", errorMsg);
      if (e instanceof Error && e.stack) {
        console.error(e.stack);
      }
      throw new Error(`Failed to initialize TreeSitterParser: ${errorMsg}`);
    } finally {
      this.isInitializing = false;
    }
  }

  static parse(code: string): any {
    if (!this.parser) {
      throw new Error("TreeSitterParser not initialized. Call init() first.");
    }
    return this.parser.parse(code);
  }

  static getLanguage(): any {
    return this.language;
  }

  static resetForTest(): void {
    this.parser = null;
    this.language = null;
    this.isInitializing = false;
  }
}
