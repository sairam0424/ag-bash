import { z } from "zod";
import type { Bash } from "../Bash.js";
import { WebFetchTool } from "../commands/ag-web/ag-web-fetch.js";
import { WebSearchTool } from "../commands/ag-web/ag-web-search.js";
import { LspTool } from "../lsp/LspTool.js";
import { ConvertTool } from "./ConvertTool.js";
import { EditTool } from "./EditTool.js";
import { MultiReplaceTool } from "./MultiReplaceTool.js";
import { FindFilesTool, GrepTool } from "./SearchTool.js";
import { ExplainTool, FindSymbolTool, HoverTool } from "./SemanticTool.js";
import { TodoTool } from "./TodoTool.js";
import { buildTool, type ToolboxTool } from "./Tool.js";
import type { PermissionResult, ValidationResult } from "./types.js";

/**
 * Defaults for all tools (fail-closed where it matters).
 */
const _TOOL_DEFAULTS = {
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: async (_bash: Bash): Promise<PermissionResult> => ({
    behavior: "allow",
  }),
  validateInput: async (): Promise<ValidationResult> => ({ result: true }),
};

const MAX_TOOL_RESULT_SIZE = 100_000;
const ARTIFACT_DIR = "/.ag-bash/artifacts";

/**
 * Normalizes quotes to prevent matching failures caused by LLM-generated smart quotes.
 */
function normalizeQuotes(text: string): string {
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

/**
 * Helper to build a tool with safe defaults.
 */

/**
 * BashToolbox - Central registry for all agentic tools.
 *
 * Enforces schema validation and provides metadata for AI SDKs.
 */
export class BashToolbox {
  private tools: Map<string, ToolboxTool> = new Map();

  constructor() {
    this.registerCoreTools();
  }

  private registerCoreTools() {
    this.registerTool(
      buildTool({
        name: "read_file",
        description: "Read the contents of a file from the virtual filesystem.",
        parameters: z.object({
          path: z.string().describe("Absolute path to the file to read."),
        }),
        isReadOnly: true,
        execute: async (bash: Bash, { path }: { path: string }) => {
          try {
            const content = await bash.fs.readFile(path, "utf-8");
            bash.updateFileState(path, { content });
            return content;
          } catch (error: any) {
            return `Error reading file: ${error.message}`;
          }
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "write_file",
        description: "Create or overwrite a file in the virtual filesystem.",
        parameters: z.object({
          path: z.string().describe("Absolute path to the file to write."),
          content: z.string().describe("The content to write to the file."),
        }),
        isDestructive: true,
        execute: async (
          bash: Bash,
          { path, content }: { path: string; content: string },
        ) => {
          try {
            await bash.fs.mkdir("/.ag-bash", { recursive: true });
            await bash.writeFileDirect(path, content);
            await bash.indexer.indexFile(path);
            await bash.saveIndex();
            await bash.lsp.notifyDidChange(path, content);
            return `Successfully wrote to ${path}.`;
          } catch (error: any) {
            return `Error writing file ${path}: ${error.message}`;
          }
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "list_dir",
        description: "List contents of a directory.",
        parameters: z.object({
          path: z.string().describe("Absolute path to the directory to list."),
        }),
        isReadOnly: true,
        execute: async (bash: Bash, { path }: { path: string }) => {
          try {
            const files = await bash.listDirDirect(path);
            return files.join("\n");
          } catch (error: any) {
            return `Error listing directory ${path}: ${error.message}`;
          }
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "edit_file",
        description: "Apply a text patch to a file (simple find and replace).",
        parameters: z.object({
          path: z.string().describe("Absolute path to the file to edit."),
          target: z.string().describe("The exact text block to be replaced."),
          replacement: z.string().describe("The new text to insert instead."),
          replace_all: z
            .boolean()
            .optional()
            .describe(
              "If true, replaces all occurrences instead of just the first one.",
            ),
        }),
        isDestructive: true,
        execute: async (
          bash: Bash,
          {
            path,
            target,
            replacement,
            replace_all,
          }: {
            path: string;
            target: string;
            replacement: string;
            replace_all?: boolean;
          },
        ) => {
          try {
            // Staleness check
            const state = bash.getFileState(path);
            const currentContent = await bash.readFileDirect(path);

            if (state && state.content !== currentContent) {
              return `Stale Edit Error: The file ${path} has changed since you last read it. Please read it again before applying edits.`;
            }

            const normalizedContent = normalizeQuotes(currentContent);
            const normalizedTarget = normalizeQuotes(target);

            if (!normalizedContent.includes(normalizedTarget)) {
              return `Error: target content not found in ${path}. Make sure it matches exactly (ignoring smart quotes).`;
            }

            let newContent: string;
            if (replace_all) {
              const escapedTarget = normalizedTarget.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
              );
              const regex = new RegExp(escapedTarget, "g");
              const matches = [...normalizedContent.matchAll(regex)];

              newContent = currentContent;
              let offset = 0;
              for (const match of matches) {
                const start = match.index! + offset;
                const end = start + normalizedTarget.length;
                newContent =
                  newContent.substring(0, start) +
                  replacement +
                  newContent.substring(end);
                offset += replacement.length - normalizedTarget.length;
              }
            } else {
              const index = normalizedContent.indexOf(normalizedTarget);
              newContent =
                currentContent.substring(0, index) +
                replacement +
                currentContent.substring(index + normalizedTarget.length);
            }

            await bash.fs.mkdir("/.ag-bash", { recursive: true });
            await bash.writeFileDirect(path, newContent);
            await bash.indexer.indexFile(path);
            await bash.saveIndex();
            return `Successfully edited ${path}.`;
          } catch (error: any) {
            return `Error editing file ${path}: ${error.message}`;
          }
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "analyze_code",
        description: "Perform semantic analysis on a source file.",
        parameters: z.object({
          path: z.string().describe("Absolute path to the file to analyze."),
        }),
        execute: async (bash: Bash, { path }: { path: string }) => {
          try {
            const content = await bash.readFileDirect(path);
            const { parse } = await import("../parser/parser.js");
            const ast = parse(content);
            const { SemanticEngine } = await import(
              "../lsp/semantic-engine.js"
            );
            const engine = new SemanticEngine(ast as any);
            return {
              type: "shell",
              symbols: engine.getAllSymbols(),
            };
          } catch (error: any) {
            return `Error analyzing file ${path}: ${error.message}`;
          }
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "find_symbols",
        description:
          "Search for symbols (functions, variables) across the workspace.",
        parameters: z.object({
          query: z
            .string()
            .optional()
            .describe("Query to filter symbol names."),
        }),
        execute: async (bash: Bash, { query }: { query?: string }) => {
          return await bash.indexer.findSymbols(query);
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "run_command",
        description: "Execute a shell command in the sandbox.",
        parameters: z.object({
          command: z.string().describe("The shell command to execute."),
        }),
        isReadOnly: (args: { command: string }) => {
          const cmd = args.command.trim().split(/\s+/)[0];
          const readOnlyCommands = [
            "ls",
            "cat",
            "grep",
            "find",
            "pwd",
            "printenv",
            "echo",
            "id",
            "whoami",
            "stat",
            "df",
            "du",
            "ls-R",
            "tree",
            "ag-hover",
            "ag-explain",
            "ag-find-symbol",
          ];
          return (
            readOnlyCommands.includes(cmd) &&
            !args.command.includes(">") &&
            !args.command.includes("|")
          );
        },
        isDestructive: (args: { command: string }) => {
          const cmd = args.command.trim().split(/\s+/)[0];
          const destructiveCommands = [
            "rm",
            "mv",
            "mkdir",
            "touch",
            "chmod",
            "chown",
            "truncate",
            "dd",
            "cp",
          ];
          return (
            destructiveCommands.includes(cmd) || args.command.includes(">")
          );
        },
        execute: async (bash: Bash, { command }: { command: string }) => {
          const result = await bash.exec(command);
          return result;
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "grep_search",
        description: "Search for a text pattern across multiple files.",
        parameters: z.object({
          path: z
            .string()
            .describe("Absolute path to the directory to search in."),
          query: z
            .string()
            .describe("The text or regex pattern to search for."),
        }),
        execute: async (
          bash: Bash,
          { path, query }: { path: string; query: string },
        ) => {
          try {
            const result = await bash.exec(`grep -r "${query}" ${path}`);
            return result.stdout || result.stderr || "No matches found.";
          } catch (error: any) {
            return `Error searching in ${path}: ${error.message}`;
          }
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "index_workspace",
        description:
          "Trigger a full scan and indexing of all supported files in the workspace.",
        parameters: z.object({
          path: z
            .string()
            .optional()
            .describe("Root directory to scan. Defaults to /."),
        }),
        execute: async (bash: Bash, { path }: { path?: string }) => {
          try {
            await bash.indexer.fullScan(path || "/");
            await bash.saveIndex();
            return "Successfully indexed the workspace.";
          } catch (error: any) {
            return `Error indexing workspace: ${error.message}`;
          }
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "get_references",
        description: "Find all references to a function or variable.",
        parameters: z.object({
          name: z
            .string()
            .optional()
            .describe("The name of the symbol to find"),
          path: z
            .string()
            .optional()
            .describe("Path to the file where the symbol is referenced"),
          line: z.number().optional().describe("1-based line number"),
          character: z
            .number()
            .optional()
            .describe("1-based character position"),
        }),
        execute: async (
          bash: Bash,
          {
            name,
            path,
            line,
            character,
          }: {
            name?: string;
            path?: string;
            line?: number;
            character?: number;
          },
        ) => {
          let symbolName = name;
          if (
            !symbolName &&
            path &&
            line !== undefined &&
            character !== undefined
          ) {
            const content = await bash.readFileDirect(path);
            const lines = content.split("\n");
            const lineText = lines[line - 1] || "";
            const symbolPattern = /[\w$!]+/g;
            let match;
            while ((match = symbolPattern.exec(lineText)) !== null) {
              if (
                character - 1 >= match.index &&
                character - 1 < match.index + match[0].length
              ) {
                symbolName = match[0];
                break;
              }
            }
          }

          if (!symbolName) return "Symbol not found at position.";

          const occurrences = bash.semanticEngine.getOccurrences(symbolName);
          if (occurrences.length === 0) {
            return `No references found for '${symbolName}'.`;
          }

          const refs = occurrences
            .filter((o) => !o.isDefinition)
            .map((o) => `  Line ${o.line}:0 [${o.scope}]`)
            .join("\n");

          const def = occurrences.find((o) => o.isDefinition);
          let output = `Found ${occurrences.length} occurrences of '${symbolName}':\n`;
          if (def) output += `Definition: Line ${def.line}:0\n`;
          if (refs) output += `References:\n${refs}`;

          return output;
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "hover_info",
        description: "Get information about a symbol at a specific position.",
        parameters: z.object({
          path: z.string().describe("Path to the file"),
          line: z.number().describe("1-based line number"),
          character: z.number().describe("1-based character position"),
        }),
        execute: async (
          bash: Bash,
          {
            path,
            line,
            character,
          }: { path: string; line: number; character: number },
        ) => {
          const content = await bash.readFileDirect(path);
          const lines = content.split("\n");
          const lineText = lines[line - 1] || "";
          const symbolPattern = /[\w$!]+/g;
          let symbolName;
          let match;
          while ((match = symbolPattern.exec(lineText)) !== null) {
            if (
              character - 1 >= match.index &&
              character - 1 < match.index + match[0].length
            ) {
              symbolName = match[0];
              break;
            }
          }

          if (!symbolName) return "No symbol found at position.";

          const definition = bash.semanticEngine.findDefinition(symbolName);
          if (definition) {
            return `${symbolName} (${definition.type})\nScope: ${definition.scope}\nDefined at line ${definition.line}`;
          }

          return `No info found for '${symbolName}'.`;
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "query_json",
        description: "Run a jq query against a JSON file or string.",
        parameters: z.object({
          query: z.string().describe("The jq filter/query string."),
          path: z
            .string()
            .optional()
            .describe("Optional path to a JSON file to query."),
          json: z
            .string()
            .optional()
            .describe("Optional JSON string to query directly."),
        }),
        execute: async (
          bash: Bash,
          {
            query,
            path,
            json,
          }: { query: string; path?: string; json?: string },
        ) => {
          let cmd = `echo '${(json || "").replace(/'/g, "'\\''")}' | jq '${query}'`;
          if (path) {
            cmd = `jq '${query}' ${path}`;
          }
          const result = await bash.exec(cmd);
          return result.stdout || result.stderr;
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "diff_files",
        description: "Generate a unified diff between two files.",
        parameters: z.object({
          file1: z.string().describe("Path to the first file."),
          file2: z.string().describe("Path to the second file."),
        }),
        execute: async (
          bash: Bash,
          { file1, file2 }: { file1: string; file2: string },
        ) => {
          const result = await bash.exec(`diff -u ${file1} ${file2}`);
          return result.stdout || result.stderr;
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "help_builtin",
        description: "Get detailed help for a shell builtin command.",
        parameters: z.object({
          command: z.string().describe("The name of the builtin command."),
        }),
        execute: async (bash: Bash, { command }: { command: string }) => {
          const result = await bash.exec(`help ${command}`);
          return result.stdout || result.stderr;
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "find_files",
        description: "Search for files by name or glob pattern.",
        parameters: z.object({
          path: z.string().describe("The directory to start searching from."),
          pattern: z
            .string()
            .describe("The filename pattern or glob (e.g., '*.ts')."),
        }),
        execute: async (
          bash: Bash,
          { path, pattern }: { path: string; pattern: string },
        ) => {
          const result = await bash.exec(`find ${path} -name "${pattern}"`);
          return result.stdout.split("\n").filter(Boolean);
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "explain_command",
        description: "Parse and explain a shell command.",
        parameters: z.object({
          command: z.string().describe("The shell command to explain."),
        }),
        execute: async (_bash: Bash, { command }: { command: string }) => {
          const { parse } = await import("../parser/parser.js");
          const ast = parse(command);
          return {
            type: "explanation",
            ast: JSON.parse(
              JSON.stringify(ast, (k, v) => (k === "parent" ? undefined : v)),
            ),
          };
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "check_environment",
        description: "Get diagnostics about the sandboxed environment.",
        parameters: z.object({}),
        execute: async (bash: Bash) => {
          return {
            cwd: (bash as any).state.cwd,
            env: Array.from((bash as any).state.env.keys()),
            limits: bash.limits,
            version: "Ag-Bash vNext",
          };
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "run_js",
        description:
          "Execute JavaScript code in the sandbox. For persistent state, use run_js_session.",
        parameters: z.object({
          code: z.string().describe("The JS code to execute."),
        }),
        execute: async (bash: Bash, { code }: { code: string }) => {
          const result = await bash.exec(
            `js-exec -c "${code.replace(/"/g, '\\"')}"`,
          );
          return result;
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "run_js_session",
        description:
          "Execute JavaScript code in a persistent session (stateful REPL). Maintains variables and modules between calls.",
        parameters: z.object({
          code: z.string().describe("The JS code to execute."),
          sessionId: z
            .string()
            .describe("Session identifier (e.g., 'main', 'test')."),
        }),
        execute: async (
          bash: Bash,
          { code, sessionId }: { code: string; sessionId: string },
        ) => {
          const result = await bash.exec(
            `js-exec --session ${sessionId} -c "${code.replace(/"/g, '\\"')}"`,
          );
          return result;
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "run_python",
        description:
          "Execute Python code in the sandbox. For persistent state, use run_python_session.",
        parameters: z.object({
          code: z.string().describe("The Python code to execute."),
        }),
        execute: async (bash: Bash, { code }: { code: string }) => {
          const result = await bash.exec(
            `python3 -c "${code.replace(/"/g, '\\"')}"`,
          );
          return result;
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "run_python_session",
        description:
          "Execute Python code in a persistent session (stateful REPL). Maintains variables and imports between calls.",
        parameters: z.object({
          code: z.string().describe("The Python code to execute."),
          sessionId: z
            .string()
            .describe("Session identifier (e.g., 'data-analysis')."),
        }),
        execute: async (
          bash: Bash,
          { code, sessionId }: { code: string; sessionId: string },
        ) => {
          const result = await bash.exec(
            `python3 --session ${sessionId} -c "${code.replace(/"/g, '\\"')}"`,
          );
          return result;
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "close_session",
        description:
          "Terminate a persistent session and release its resources.",
        parameters: z.object({
          sessionId: z.string().describe("The ID of the session to close."),
        }),
        execute: async (bash: Bash, { sessionId }: { sessionId: string }) => {
          await bash.closeSession(sessionId);
          return `Session ${sessionId} closed.`;
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "get_definition",
        description: "Find the definition of a symbol.",
        parameters: z.object({
          name: z.string().describe("The name of the symbol to find."),
        }),
        execute: async (bash: Bash, { name }: { name: string }) => {
          const def = bash.semanticEngine.findDefinition(name);
          return def || "Definition not found.";
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "add_todo",
        description: "Add a new todo item.",
        parameters: z.object({
          task: z.string().describe("The task description."),
          status: z
            .enum(["pending", "doing", "done"])
            .optional()
            .describe("Initial status."),
        }),
        execute: async (
          bash: Bash,
          { task, status }: { task: string; status?: string },
        ) => {
          const todosPath = "/.ag-bash/todos.json";
          await bash.fs.mkdir("/.ag-bash", { recursive: true });
          let todos: any[] = [];
          if (await bash.fs.exists(todosPath)) {
            todos = JSON.parse(await bash.readFileDirect(todosPath));
          }
          const newTodo = {
            id: (todos.length + 1).toString(),
            task,
            status: status || "pending",
          };
          todos.push(newTodo);
          await bash.writeFileDirect(todosPath, JSON.stringify(todos, null, 2));
          return { success: true, id: newTodo.id };
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "list_todos",
        description: "List all todo items.",
        parameters: z.object({}),
        execute: async (bash: Bash) => {
          const todosPath = "/.ag-bash/todos.json";
          if (await bash.fs.exists(todosPath)) {
            return { todos: JSON.parse(await bash.readFileDirect(todosPath)) };
          }
          return { todos: [] };
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "update_todo",
        description: "Update the status of a todo item.",
        parameters: z.object({
          id: z.string().describe("The ID of the todo to update."),
          status: z.enum(["pending", "doing", "done"]).describe("New status."),
        }),
        execute: async (
          bash: Bash,
          { id, status }: { id: string; status: "pending" | "doing" | "done" },
        ) => {
          const todosPath = "/.ag-bash/todos.json";
          if (!(await bash.fs.exists(todosPath))) {
            return { error: "Todo not found." };
          }
          const todos = JSON.parse(await bash.readFileDirect(todosPath));
          const todo = todos.find((t: any) => t.id === id);
          if (!todo) return { error: "Todo not found." };
          todo.status = status;
          await bash.writeFileDirect(todosPath, JSON.stringify(todos, null, 2));
          return { success: true };
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "plan_enter",
        description:
          "Enter plan mode to design an approach before making changes.",
        parameters: z.object({}),
        execute: async (bash: Bash) => {
          bash.setMode("plan");
          return "Entered plan mode. You are now in read-only mode. Use plan_exit to return to execute mode when ready.";
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "plan_exit",
        description: "Exit plan mode and return to execution mode.",
        parameters: z.object({}),
        execute: async (bash: Bash) => {
          bash.setMode("execute");
          return "Exited plan mode. You can now make changes to the codebase.";
        },
      }),
    );

    this.registerTool(GrepTool);
    this.registerTool(FindFilesTool);
    this.registerTool(EditTool);
    this.registerTool(HoverTool);
    this.registerTool(FindSymbolTool);
    this.registerTool(ExplainTool);
    this.registerTool(TodoTool);
    this.registerTool(buildTool(WebSearchTool as any));
    this.registerTool(buildTool(WebFetchTool as any));
    this.registerTool(LspTool);
    this.registerTool(MultiReplaceTool);
    this.registerTool(ConvertTool);

    this.registerTool(
      buildTool({
        name: "search_tools",
        description: "Search for available tools by keyword or description.",
        parameters: z.object({
          query: z
            .string()
            .describe("Keyword to search for in tool names and descriptions."),
        }),
        isReadOnly: true,
        execute: async (_bash: Bash, { query }: { query: string }) => {
          const tools = this.getTools();
          const results = tools.filter(
            (t) =>
              t.name.includes(query) ||
              t.description.includes(query) ||
              t.searchHint?.includes(query),
          );

          if (results.length === 0) {
            return "No tools found matching your query.";
          }

          return results.map((t) => ({
            name: t.name,
            description: t.description,
            aliases: t.aliases,
          }));
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "list_mcp_tools",
        description: "List all tools available via connected MCP servers.",
        parameters: z.object({}),
        execute: async (_bash: Bash) => {
          const client = (
            await import("../services/McpClient.js")
          ).McpClient.getInstance();
          return client.listConnections().map((c) => ({
            server: c.id,
            tools: c.tools.map((t) => `${c.id}__${t.name}`),
          }));
        },
      }),
    );

    this.registerTool(
      buildTool({
        name: "sync_mcp_tools",
        description:
          "Synchronize and register all MCP tools into the central toolbox.",
        parameters: z.object({}),
        isReadOnly: true,
        execute: async (_bash: Bash) => {
          const client = (
            await import("../services/McpClient.js")
          ).McpClient.getInstance();
          const connections = client.listConnections();
          let count = 0;

          for (const conn of connections) {
            for (const tool of conn.tools) {
              const namespacedName = `mcp:${conn.id}:${tool.name}`;
              this.registerTool(
                buildTool({
                  name: namespacedName,
                  description: `[MCP: ${conn.id}] ${tool.description || ""}`,
                  parameters: z.any(), // MCP schemas are dynamic
                  execute: async (b, args) => {
                    return await client.callTool(conn.id, tool.name, args, b);
                  },
                }),
              );
              count++;
            }
          }
          return `Successfully synchronized ${count} tools from ${connections.length} MCP servers.`;
        },
      }),
    );
  }

  public registerTool(tool: ToolboxTool): void {
    this.tools.set(tool.name, tool);
  }

  public getTools(): ToolboxTool[] {
    return Array.from(this.tools.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /**
   * Performs a semantic search over the registered tools.
   */
  public async searchTools(query: string, limit = 3): Promise<ToolboxTool[]> {
    const tools = this.getTools();
    const queryLower = query.toLowerCase();
    const keywords = queryLower.split(/\s+/).filter((k) => k.length > 3);

    return tools
      .map((tool) => {
        const toolName = tool.name.toLowerCase();
        const toolDesc = tool.description.toLowerCase();
        const toolHint = (tool.searchHint || "").toLowerCase();

        // Count keyword matches
        const matchCount = keywords.filter(
          (k) =>
            toolName.includes(k) ||
            toolDesc.includes(k) ||
            toolHint.includes(k),
        ).length;

        // Check if tool name is mentioned in query
        const isNamedInQuery = queryLower.includes(toolName.replace(/_/g, " "));

        let score = 100; // Lower is better
        if (isNamedInQuery) score = 0;
        else if (matchCount > 0) score = 50 - matchCount; // More matches = lower score

        return { tool, score };
      })
      .filter((res) => res.score < 100)
      .sort((a, b) => a.score - b.score)
      .slice(0, limit)
      .map((res) => res.tool);
  }

  public getTool(name: string): ToolboxTool | undefined {
    return this.tools.get(name);
  }
  registerMcpTools(connectionId: string, tools: any[]): void {
    for (const tool of tools) {
      this.registerTool(
        buildTool({
          name: `mcp:${connectionId}:${tool.name}`,
          description: tool.description || `MCP tool from ${connectionId}`,
          parameters: this.jsonSchemaToZod(tool.inputSchema),
          execute: async (bash: Bash, args: any) => {
            const client = (
              await import("../services/McpClient.js")
            ).McpClient.getInstance();
            return await client.callTool(connectionId, tool.name, args, bash);
          },
        }),
      );
    }
  }

  /**
   * Simple JSON Schema to Zod converter for MCP tools.
   */
  private jsonSchemaToZod(schema: any): z.ZodType<any> {
    const shape: any = {};
    const props = schema.properties || {};
    for (const key in props) {
      const prop = props[key];
      let zType: any = z.string();
      if (prop.type === "number") zType = z.number();
      else if (prop.type === "boolean") zType = z.boolean();

      if (prop.description) zType = zType.describe(prop.description);
      if (!(schema.required || []).includes(key)) {
        zType = zType.optional();
      }
      shape[key] = zType;
    }
    return z.object(shape);
  }

  // Removed duplicate getTools method

  getAgenticTools(bash: Bash): Record<string, any> {
    const result: Record<string, any> = {};
    for (const tool of this.getTools()) {
      result[tool.name] = {
        description: tool.description,
        inputSchema: this.zodToJsonSchema(tool.parameters),
        effort: tool.effort,
        composeHooks: tool.composeHooks,
        execute: (args: any) => this.callTool(bash, tool.name, args),
      };
    }
    return result;
  }

  public unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  /**
   * Orchestrates the tool execution lifecycle:
   * validation -> permissions -> execution.
   */
  /**
   * Orchestrates the tool execution lifecycle:
   * validation -> permissions -> execution.
   */
  public async callTool(bash: Bash, toolName: string, args: any): Promise<any> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    // 1. Validate Input
    const validation = await tool.validateInput(args);
    if (!validation.result) {
      return `Validation Error: ${validation.message || "Invalid input"}`;
    }

    // 2. Check Permissions
    const permission = await tool.checkPermissions(bash, args);

    if (permission.behavior === "deny") {
      return `Permission Denied: ${permission.message || "Execution blocked"}`;
    }

    if (permission.behavior === "ask") {
      // In the current architecture, we might need to delegate this back to bash
      // or handle it via a UI prompt if available.
      return `Permission Required: ${permission.message || "This operation requires user approval."}`;
    }

    if (permission.behavior === "allow" && permission.updatedInput) {
      args = permission.updatedInput;
    }

    // 3. Lifecycle Events (Start)
    const startTime = Date.now();
    bash.emit("tool:start", { name: toolName, args });

    // 4. Execute
    let result: any;
    try {
      result = await tool.execute(bash, args);
    } catch (error: any) {
      result = `Execution Error in ${toolName}: ${error.message}`;
    }

    // 5. Lifecycle Events (End)
    const duration = Date.now() - startTime;
    bash.emit("tool:end", { name: toolName, result, duration });

    // 6. Resource Governance (Size Check)
    const stringResult =
      typeof result === "string" ? result : JSON.stringify(result);
    const maxSize = tool.maxResultSizeChars || MAX_TOOL_RESULT_SIZE;

    if (stringResult.length > maxSize) {
      const artifactId = Math.random().toString(36).substring(2, 10);
      const artifactPath = `${ARTIFACT_DIR}/${toolName}_${artifactId}.txt`;

      await bash.fs.mkdir(ARTIFACT_DIR, { recursive: true });
      await bash.writeFileDirect(artifactPath, stringResult);

      return {
        type: "artifact",
        message: `Tool output was too large (${stringResult.length} chars). It has been saved to an artifact file.`,
        path: artifactPath,
        preview: `${stringResult.substring(0, 1000)}...`,
      };
    }

    return result;
  }

  /**
   * Lightweight Zod to JSON Schema converter.
   */
  private zodToJsonSchema(schema: z.ZodType<any>): any {
    const shape = (schema as any).shape;
    const properties: any = {};
    const required: string[] = [];

    for (const key in shape) {
      const field = shape[key];
      const desc = field.description;

      let type = "string";
      let enumValues: string[] | undefined;

      if (field instanceof z.ZodString) {
        type = "string";
      } else if (field instanceof z.ZodNumber) {
        type = "number";
      } else if (field instanceof z.ZodBoolean) {
        type = "boolean";
      } else if (field instanceof z.ZodEnum) {
        type = "string";
        enumValues = (field as any)._def.values;
      } else if (field instanceof z.ZodOptional) {
        // Handle optional fields
        const inner = (field as any)._def.innerType;
        if (inner instanceof z.ZodString) type = "string";
        else if (inner instanceof z.ZodNumber) type = "number";
        else if (inner instanceof z.ZodBoolean) type = "boolean";
        else if (inner instanceof z.ZodEnum) {
          type = "string";
          enumValues = (inner as any)._def.values;
        }
      }

      properties[key] = {
        type,
        ...(desc && { description: desc }),
        ...(enumValues && { enum: enumValues }),
      };

      if (!(field instanceof z.ZodOptional)) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      required,
    };
  }
}
