// @ts-ignore - Importing from vendored file
import * as TreeSitter from './vendor/web-tree-sitter.js';

/**
 * TreeSitterParser handles WASM initialization and parser instantiation
 * for the v2.9 AST-based transition.
 */
export class TreeSitterParser {
  private static parser: any = null;
  private static languages: Map<string, any> = new Map();
  private static isInitializing = false;

  static async init(options: {
    webTreeSitterWasm: string | Uint8Array;
    grammars?: Record<string, string | Uint8Array>;
  }): Promise<void> {
    if (this.parser && (!options.grammars || Object.keys(options.grammars).every(lang => this.languages.has(lang)))) return;
    
    if (this.isInitializing) {
      while (this.isInitializing) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return;
    }

    this.isInitializing = true;
    try {
      const { Parser, Language } = TreeSitter as any;
      
      if (!this.parser) {
        console.log("[TreeSitterParser] Initializing core with vendored library...");
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
      }
      
      if (options.grammars) {
        for (const [name, grammar] of Object.entries(options.grammars)) {
          if (this.languages.has(name)) continue;
          
          console.log(`[TreeSitterParser] Loading grammar: ${name}`);
          const grammarWasm = grammar instanceof Uint8Array 
            ? grammar 
            : (typeof grammar === 'string' ? grammar : new Uint8Array(grammar as any));

          const language = await Language.load(grammarWasm);
          this.languages.set(name, language);
        }
      }

      // Default to bash if available and nothing set
      if (!this.parser.getLanguage() && this.languages.has('bash')) {
        this.parser.setLanguage(this.languages.get('bash'));
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error("[TreeSitterParser] Initialization FAILED:", errorMsg);
      throw new Error(`Failed to initialize TreeSitterParser: ${errorMsg}`);
    } finally {
      this.isInitializing = false;
    }
  }

  static async loadLanguage(name: string, grammarWasm: string | Uint8Array): Promise<void> {
    if (this.languages.has(name)) return;
    const { Language } = TreeSitter as any;
    const wasm = grammarWasm instanceof Uint8Array 
      ? grammarWasm 
      : (typeof grammarWasm === 'string' ? grammarWasm : new Uint8Array(grammarWasm as any));
    const language = await Language.load(wasm);
    this.languages.set(name, language);
  }

  static setLanguage(name: string): void {
    const lang = this.languages.get(name);
    if (!lang) {
      throw new Error(`Language '${name}' not loaded. Call loadLanguage() or init() first.`);
    }
    this.parser.setLanguage(lang);
  }

  static parse(code: string, language?: string): any {
    if (!this.parser) {
      throw new Error("TreeSitterParser not initialized. Call init() first.");
    }
    if (language) {
      this.setLanguage(language);
    }
    return this.parser.parse(code);
  }

  static getLanguage(name?: string): any {
    if (name) return this.languages.get(name);
    return this.parser?.getLanguage();
  }

  static resetForTest(): void {
    this.parser = null;
    this.languages.clear();
    this.isInitializing = false;
  }
}

