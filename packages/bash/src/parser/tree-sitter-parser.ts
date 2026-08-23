/**
 * TreeSitterParser handles WASM initialization and parser instantiation
 * for the v2.9 AST-based transition.
 *
 * The vendored `web-tree-sitter.js` emscripten glue (153,666 bytes) is loaded
 * through a DYNAMIC import, never a static top-level one. Every importer of
 * this module — ParseStage, ServiceContainer, WorkspaceIndexer, ag-analyze —
 * is on the CLI's startup path, but the tree-sitter engine is not: `Bash`
 * defaults `parser.engine` to "legacy" and ParseStage gates both tree-sitter
 * branches on `parserEngine === "tree-sitter"`. A static import therefore made
 * Node parse and evaluate the whole glue on 100% of invocations to serve 0% of
 * them. See tree-sitter-parser.lazy-glue.test.ts for the pinned contract.
 */
// Converting this to a const-object (to satisfy noStaticOnlyClass) surfaces the
// private static fields into the public type, which trips TS9013
// (--isolatedDeclarations) on the inferred `Map<string, any>` initializer. The
// static class keeps that state private and is the clearer model for a
// one-time-initialized parser singleton.
// biome-ignore lint/complexity/noStaticOnlyClass: stateful WASM-singleton holder; see note above.
export class TreeSitterParser {
  private static parser: any = null;
  private static languages: Map<string, any> = new Map();
  private static initPromise: Promise<void> | null = null;
  private static treeSitterPromise: Promise<any> | null = null;

  /**
   * Resolves the vendored emscripten glue on first use. The promise is cached
   * so concurrent callers share one evaluation; Node's own ESM cache makes a
   * repeat `import()` free, but caching here keeps `loadLanguage()` free of an
   * await-on-microtask per grammar too.
   */
  private static loadTreeSitter(): Promise<any> {
    if (TreeSitterParser.treeSitterPromise) {
      return TreeSitterParser.treeSitterPromise;
    }
    // The specifier stays a single-line string literal on purpose: the
    // check-banned-patterns.js "Dynamic import() with non-literal specifier"
    // rule matches `import(` not immediately followed by a quote, so wrapping
    // the argument onto its own line would read as a tainted-specifier vector.
    // @ts-expect-error - Importing from vendored file
    const glue: Promise<any> = import("./vendor/web-tree-sitter.js");
    TreeSitterParser.treeSitterPromise = glue;
    return glue;
  }

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

    if (TreeSitterParser.initPromise) {
      return TreeSitterParser.initPromise;
    }

    TreeSitterParser.initPromise = TreeSitterParser.doInit(options);
    return TreeSitterParser.initPromise;
  }

  private static async doInit(options: {
    webTreeSitterWasm: string | Uint8Array;
    grammars?: Record<string, string | Uint8Array>;
  }): Promise<void> {
    try {
      const { Parser, Language } =
        (await TreeSitterParser.loadTreeSitter()) as any;

      if (!TreeSitterParser.parser) {
        // Initializing core with vendored library
        if (!Parser) {
          throw new Error(
            "Parser class not found in vendored web-tree-sitter module.",
          );
        }

        const initOptions: any = Object.create(null);
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

          // Loading grammar silently
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
        !TreeSitterParser.parser.language &&
        TreeSitterParser.languages.has("bash")
      ) {
        TreeSitterParser.parser.setLanguage(
          TreeSitterParser.languages.get("bash"),
        );
      }
    } catch (e) {
      TreeSitterParser.initPromise = null;
      const errorMsg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to initialize TreeSitterParser: ${errorMsg}`);
    }
  }

  static async loadLanguage(
    name: string,
    grammarWasm: string | Uint8Array,
  ): Promise<void> {
    if (TreeSitterParser.languages.has(name)) return;
    const { Language } = (await TreeSitterParser.loadTreeSitter()) as any;
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
    return TreeSitterParser.parser?.language;
  }

  static resetForTest(): void {
    TreeSitterParser.parser = null;
    TreeSitterParser.languages.clear();
    TreeSitterParser.initPromise = null;
  }
}
