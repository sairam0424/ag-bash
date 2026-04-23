// @ts-expect-error - Importing from vendored file
import * as TreeSitter from "./vendor/web-tree-sitter.js";

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
    if (
      TreeSitterParser.parser &&
      (!options.grammars ||
        Object.keys(options.grammars).every((lang) =>
          TreeSitterParser.languages.has(lang),
        ))
    )
      return;

    if (TreeSitterParser.isInitializing) {
      while (TreeSitterParser.isInitializing) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return;
    }

    TreeSitterParser.isInitializing = true;
    try {
      const { Parser, Language } = TreeSitter as any;

      if (!TreeSitterParser.parser) {
        console.log(
          "[TreeSitterParser] Initializing core with vendored library...",
        );
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
        TreeSitterParser.parser = new Parser();
      }

      if (options.grammars) {
        for (const [name, grammar] of Object.entries(options.grammars)) {
          if (TreeSitterParser.languages.has(name)) continue;

          console.log(`[TreeSitterParser] Loading grammar: ${name}`);
          const grammarWasm =
            grammar instanceof Uint8Array
              ? grammar
              : typeof grammar === "string"
                ? grammar
                : new Uint8Array(grammar as any);

          const language = await Language.load(grammarWasm);
          TreeSitterParser.languages.set(name, language);
        }
      }

      // Default to bash if available and nothing set
      if (
        !TreeSitterParser.parser.getLanguage() &&
        TreeSitterParser.languages.has("bash")
      ) {
        TreeSitterParser.parser.setLanguage(
          TreeSitterParser.languages.get("bash"),
        );
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error("[TreeSitterParser] Initialization FAILED:", errorMsg);
      throw new Error(`Failed to initialize TreeSitterParser: ${errorMsg}`);
    } finally {
      TreeSitterParser.isInitializing = false;
    }
  }

  static async loadLanguage(
    name: string,
    grammarWasm: string | Uint8Array,
  ): Promise<void> {
    if (TreeSitterParser.languages.has(name)) return;
    const { Language } = TreeSitter as any;
    const wasm =
      grammarWasm instanceof Uint8Array
        ? grammarWasm
        : typeof grammarWasm === "string"
          ? grammarWasm
          : new Uint8Array(grammarWasm as any);
    const language = await Language.load(wasm);
    TreeSitterParser.languages.set(name, language);
  }

  static setLanguage(name: string): void {
    const lang = TreeSitterParser.languages.get(name);
    if (!lang) {
      throw new Error(
        `Language '${name}' not loaded. Call loadLanguage() or init() first.`,
      );
    }
    TreeSitterParser.parser.setLanguage(lang);
  }

  static parse(code: string, language?: string): any {
    if (!TreeSitterParser.parser) {
      throw new Error("TreeSitterParser not initialized. Call init() first.");
    }
    if (language) {
      TreeSitterParser.setLanguage(language);
    }
    return TreeSitterParser.parser.parse(code);
  }

  static getLanguage(name?: string): any {
    if (name) return TreeSitterParser.languages.get(name);
    return TreeSitterParser.parser?.getLanguage();
  }

  static resetForTest(): void {
    TreeSitterParser.parser = null;
    TreeSitterParser.languages.clear();
    TreeSitterParser.isInitializing = false;
  }
}
