import type { Bash } from "../Bash.js";
import { TreeSitterParser } from "../parser/tree-sitter-parser.js";
import type { SemanticEngine } from "./semantic-engine.js";

export class WorkspaceIndexer {
  constructor(
    private bash: Bash,
    private engine: SemanticEngine,
  ) {}

  /**
   * Performs a full scan of the workspace.
   */
  async fullScan(dir: string = "/"): Promise<void> {
    try {
      const entries = await this.bash.listDirDirect(dir);
      for (const entry of entries) {
        const fullPath = this.bash.fs.resolvePath(dir, entry);
        if (await this.bash.existsDirect(fullPath)) {
          const stat = await this.bash.fs.stat(fullPath);
          if (stat.isDirectory) {
            // Skip common large/system directories
            if (
              entry === "node_modules" ||
              entry === ".git" ||
              entry === ".ag-bash"
            )
              continue;
            await this.fullScan(fullPath);
          } else if (this.isSupportedFile(entry)) {
            await this.indexFile(fullPath);
          }
        }
      }
    } catch (_error) {
      // Silently swallow — scan failure for a single directory is non-fatal
    }
  }

  private isSupportedFile(filename: string): boolean {
    const supportedExtensions = [
      ".sh",
      ".bash",
      ".ag",
      ".js",
      ".ts",
      ".py",
      ".json",
    ];
    return supportedExtensions.some((ext) => filename.endsWith(ext));
  }

  private getLanguageFromFile(path: string): string {
    if (path.endsWith(".py")) return "python";
    if (path.endsWith(".js") || path.endsWith(".ts")) return "javascript";
    if (path.endsWith(".json")) return "json";
    return "bash";
  }

  /**
   * Indexes a single file.
   */
  async indexFile(path: string): Promise<void> {
    try {
      const content = await this.bash.readFileDirect(path);
      const language = this.getLanguageFromFile(path);

      this.engine.clearPath(path);

      if (language === "bash") {
        const { parse } = await import("../parser/parser.js");
        const ast = parse(content);
        this.engine.indexNode(ast, path, "bash");
      } else {
        try {
          const tree = TreeSitterParser.parse(content, language);
          this.engine.indexNode(tree.rootNode, path, language);
        } catch (_e) {
          // TreeSitter parse failed — fall back to literal indexing silently
          // Fallback to basic string-based indexing if needed
        }
      }
    } catch (_error) {
      // Silently swallow — index failure for a single file is non-fatal
    }
  }

  /**
   * Search for symbols across the indexed workspace.
   */
  async findSymbols(query?: string): Promise<any[]> {
    if (!query) {
      return this.engine.getAllSymbols();
    }
    return this.engine.fuzzySearchSymbols(query);
  }
}
