import type { Bash } from "../Bash.js";
import { SemanticEngine } from "./semantic-engine.js";
import { parse } from "../parser/parser.js";

export class WorkspaceIndexer {
  constructor(private bash: Bash, private engine: SemanticEngine) {}

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
            if (entry === "node_modules" || entry === ".git" || entry === ".ag-bash") continue;
            await this.fullScan(fullPath);
          } else if (this.isSupportedFile(entry)) {
            await this.indexFile(fullPath);
          }
        }
      }
    } catch (error) {
      console.error(`Failed to scan directory ${dir}:`, error);
    }
  }

  private isSupportedFile(filename: string): boolean {
    // Currently we only support shell scripts for symbol indexing
    return filename.endsWith(".sh") || filename.endsWith(".bash") || filename.endsWith(".ag");
  }

  /**
   * Indexes a single file.
   */
  async indexFile(path: string): Promise<void> {
    try {
      const content = await this.bash.readFileDirect(path);
      const ast = parse(content);
      this.engine.clearPath(path);
      this.engine.indexNode(ast, path);
    } catch (error) {
      console.error(`Failed to index file ${path}:`, error);
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
