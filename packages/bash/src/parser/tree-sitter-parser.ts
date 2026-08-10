// @ts-expect-error - Importing from vendored file
import * as TreeSitter from "./vendor/web-tree-sitter.js";

/**
 * TreeSitterParser handles WASM initialization and parser instantiation
 * for the v2.9 AST-based transition.
 *
 * Each instance is fully isolated — no shared static state. Multiple Bash
 * instances can each own their own parser without cross-contamination.
 */
export class TreeSitterParser {
  private parser: any = null;
  private languages: Map<string, any> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private initConfig: {
    webTreeSitterWasm: string | Uint8Array;
    grammars?: Record<string, string | Uint8Array>;
  } | null = null;

  /**
   * Ensures the parser is initialized exactly once. Concurrent callers
   * await the same promise instead of busy-waiting.
   */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      if (!this.initConfig) {
        throw new Error(
          "TreeSitterParser: no configuration provided. Call configure() before ensureInitialized().",
        );
      }
      this.initPromise = this.doInit(this.initConfig);
    }
    return this.initPromise;
  }

  /**
   * Set initialization configuration. Must be called before ensureInitialized().
   */
  configure(options: {
    webTreeSitterWasm: string | Uint8Array;
    grammars?: Record<string, string | Uint8Array>;
  }): void {
    this.initConfig = options;
  }

  async init(options: {
    webTreeSitterWasm: string | Uint8Array;
    grammars?: Record<string, string | Uint8Array>;
  }): Promise<void> {
    if (
      this.parser &&
      (!options.grammars ||
        Object.keys(options.grammars).every((lang) =>
          this.languages.has(lang),
        ))
    ) {
      return;
    }

    this.initConfig = options;
    if (!this.initPromise) {
      this.initPromise = this.doInit(options);
    }
    return this.initPromise;
  }

  private async doInit(options: {
    webTreeSitterWasm: string | Uint8Array;
    grammars?: Record<string, string | Uint8Array>;
  }): Promise<void> {
    try {
      const { Parser, Language } = TreeSitter as any;

      if (!this.parser) {
        if (!Parser) {
          throw new Error(
            "Parser class not found in vendored web-tree-sitter module.",
          );
        }

        const initOptions: any = {};
        if (
          options.webTreeSitterWasm instanceof Uint8Array ||
          Buffer.isBuffer(options.webTreeSitterWasm)
        ) {
          initOptions.wasmBinary = options.webTreeSitterWasm;
        } else {
          initOptions.locateFile = (scriptName: string) => {
            if (scriptName === "web-tree-sitter.wasm") {
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

          const grammarWasm =
            grammar instanceof Uint8Array
              ? grammar
              : typeof grammar === "string"
                ? grammar
                : new Uint8Array(grammar as any);

          const language = await Language.load(grammarWasm);
          this.languages.set(name, language);
        }
      }

      // Default to bash if available and nothing set
      if (!this.parser.getLanguage() && this.languages.has("bash")) {
        this.parser.setLanguage(this.languages.get("bash"));
      }

      this.initialized = true;
    } catch (e) {
      // Reset the promise so a retry is possible after fixing the issue
      this.initPromise = null;
      const errorMsg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to initialize TreeSitterParser: ${errorMsg}`);
    }
  }

  async loadLanguage(
    name: string,
    grammarWasm: string | Uint8Array,
  ): Promise<void> {
    if (this.languages.has(name)) return;
    const { Language } = TreeSitter as any;
    const wasm =
      grammarWasm instanceof Uint8Array
        ? grammarWasm
        : typeof grammarWasm === "string"
          ? grammarWasm
          : new Uint8Array(grammarWasm as any);
    const language = await Language.load(wasm);
    this.languages.set(name, language);
  }

  setLanguage(name: string): void {
    const lang = this.languages.get(name);
    if (!lang) {
      throw new Error(
        `Language '${name}' not loaded. Call loadLanguage() or init() first.`,
      );
    }
    this.parser.setLanguage(lang);
  }

  parse(code: string, language?: string): any {
    if (!this.parser) {
      throw new Error("TreeSitterParser not initialized. Call init() first.");
    }
    if (language) {
      this.setLanguage(language);
    }
    return this.parser.parse(code);
  }

  getLanguage(name?: string): any {
    if (name) return this.languages.get(name);
    return this.parser?.getLanguage();
  }

  resetForTest(): void {
    this.parser = null;
    this.languages.clear();
    this.initialized = false;
    this.initPromise = null;
    this.initConfig = null;
  }
}
