import type { Bash } from "./Bash.js";
import { sanitizeErrorMessage } from "./fs/sanitize-error.js";
import { parse } from "./parser/parser.js";
import { SemanticEngine } from "./lsp/semantic-engine.js";

/**
 * Creates granular agentic tools for the bash sandbox.
 */
export function createAgenticTools(sandbox: Bash): Record<string, any> {
  return {
    read_file: {
      description: "Read the contents of a file from the virtual filesystem. Provides file content and tracks its state to detect staleness.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file to read.",
          },
        },
        required: ["path"] as const,
      } as const,
      execute: async ({ path }: { path: string }): Promise<any> => {
        try {
          const content = await sandbox.fs.readFile(path);
          // Update file state
          sandbox.fileState.set(path, {
            content,
            timestamp: Date.now(),
          });
          return { content };
        } catch (error: any) {
          return { 
            error: sanitizeErrorMessage(error.message),
            suggestions: await suggestSimilarFiles(sandbox, path)
          };
        }
      },
    },
    write_file: {
      description: "Create or overwrite a file in the virtual filesystem.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file to write.",
          },
          content: {
            type: "string",
            description: "The content to write to the file.",
          },
        },
        required: ["path", "content"] as const,
      } as const,
      execute: async ({ path, content }: { path: string; content: string }): Promise<any> => {
        try {
          await sandbox.fs.writeFile(path, content);
          // Update file state
          sandbox.fileState.set(path, {
            content,
            timestamp: Date.now(),
          });
          return { success: true };
        } catch (error: any) {
          return { error: sanitizeErrorMessage(error.message) };
        }
      },
    },
    edit_file: {
      description: "Apply one or more text patches to a file. Each patch replaces 'oldText' with 'newText'. Supports fuzzy matching for whitespace and line endings.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file to edit.",
          },
          patches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                oldText: {
                  type: "string",
                  description: "The exact text block to be replaced.",
                },
                newText: {
                  type: "string",
                  description: "The new text to insert instead.",
                },
              },
              required: ["oldText", "newText"] as const,
            },
          },
        },
        required: ["path", "patches"] as const,
      } as const,
      execute: async ({ path, patches }: { path: string; patches: { oldText: string; newText: string }[] }): Promise<any> => {
        try {
          let content = await sandbox.fs.readFile(path);
          const originalContent = content;
          
          for (const patch of patches) {
            if (!content.includes(patch.oldText)) {
              // Fuzzy matching: line-by-line trimmed comparison
              const lines = content.split("\n");
              const oldLines = patch.oldText.split("\n").map(l => l.trim());
              
              let foundIndex = -1;
              for (let i = 0; i <= lines.length - oldLines.length; i++) {
                let match = true;
                for (let j = 0; j < oldLines.length; j++) {
                  // Skip empty lines in patch if they don't match exactly
                  if (oldLines[j] === "" && lines[i+j].trim() !== "") {
                    match = false;
                    break;
                  }
                  if (lines[i+j].trim() !== oldLines[j]) {
                    match = false;
                    break;
                  }
                }
                if (match) {
                  foundIndex = i;
                  break;
                }
              }

              if (foundIndex !== -1) {
                lines.splice(foundIndex, oldLines.length, patch.newText);
                content = lines.join("\n");
              } else {
                 return { 
                  error: `Could not find match for patch in ${path}`,
                  failedPatch: patch.oldText,
                  context: "The text to be replaced must match closely (ignoring indentation). Please check the content."
                };
              }
            } else {
              content = content.replace(patch.oldText, patch.newText);
            }
          }
          
          if (content === originalContent) {
            return { success: true, message: "No changes applied (file content already matched target state)." };
          }
          
          await sandbox.fs.writeFile(path, content);
          sandbox.fileState.set(path, {
            content,
            timestamp: Date.now(),
          });
          
          return { success: true };
        } catch (error: any) {
          return { error: sanitizeErrorMessage(error.message) };
        }
      },
    },
    list_files: {
      description: "List contents of a directory in the virtual filesystem.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the directory to list.",
          },
          recursive: {
            type: "boolean",
            description: "Whether to list subdirectories recursively.",
          },
        },
        required: ["path"] as const,
      } as const,
      execute: async ({ path, recursive }: { path: string; recursive?: boolean }): Promise<any> => {
        try {
          if (recursive) {
             const result = await sandbox.exec(`ls -R ${path}`);
             return { output: result.stdout || result.stderr };
          }
          const files = await sandbox.fs.readdir(path);
          return { files };
        } catch (error: any) {
          return { error: sanitizeErrorMessage(error.message) };
        }
      },
    },
    analyze_code: {
      description: "Perform semantic analysis on a source file. For shell scripts, lists functions, variables, and commands.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file to analyze.",
          },
        },
        required: ["path"] as const,
      } as const,
      execute: async ({ path }: { path: string }): Promise<any> => {
        try {
          const content = await sandbox.fs.readFile(path);
          
          // Basic file stats for all files
          const lines = content.split("\n");
          const stats = {
            lineCount: lines.length,
            byteCount: Buffer.byteLength(content),
            extension: path.split(".").pop() || "",
            summary: lines.slice(0, 10).join("\n") + (lines.length > 10 ? "\n..." : ""),
          };

          // Semantic analysis for shell scripts
          if (stats.extension === "sh" || content.startsWith("#!/bin/bash") || content.startsWith("#!/bin/sh")) {
            try {
              const ast = parse(content);
              const engine = new SemanticEngine(ast);
              const symbols = engine.getAllSymbols();
              
              return {
                ...stats,
                type: "shell",
                symbols: symbols.map(s => ({
                  name: s.name,
                  type: s.type,
                  line: s.line,
                  scope: s.scope
                }))
              };
            } catch (parseError) {
              return {
                ...stats,
                type: "shell",
                error: "Failed to parse script for semantic analysis.",
                parseError: sanitizeErrorMessage((parseError as Error).message)
              };
            }
          }

          return {
            ...stats,
            type: "generic",
            message: "Deep semantic analysis only supported for shell scripts in this version."
          };
        } catch (error: any) {
          return { error: sanitizeErrorMessage(error.message) };
        }
      },
    },
    find_symbols: {
      description: "Search for symbols (functions, variables) across all shell scripts in a directory.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the directory to search in.",
          },
          query: {
            type: "string",
            description: "Optional query to filter symbol names.",
          },
        },
        required: ["path"] as const,
      } as const,
      execute: async ({ path, query }: { path: string; query?: string }): Promise<any> => {
        try {
          const results: any[] = [];
          const walk = async (dir: string) => {
            const entries = await sandbox.fs.readdir(dir);
            for (const entry of entries) {
              const fullPath = dir === "/" ? `/${entry}` : `${dir}/${entry}`;
              try {
                const stat = await sandbox.fs.stat(fullPath);
                if (stat.isDirectory) {
                  await walk(fullPath);
                } else if (entry.endsWith(".sh")) {
                  const content = await sandbox.fs.readFile(fullPath);
                  const ast = parse(content);
                  const engine = new SemanticEngine(ast);
                  const symbols = engine.getAllSymbols();
                  for (const sym of symbols) {
                    if (!query || sym.name.toLowerCase().includes(query.toLowerCase())) {
                      results.push({
                        name: sym.name,
                        type: sym.type,
                        line: sym.line,
                        path: fullPath
                      });
                    }
                  }
                }
              } catch { /* ignore individual file errors */ }
            }
          };

          await walk(path);
          return { results };
        } catch (error: any) {
          return { error: sanitizeErrorMessage(error.message) };
        }
      },
    },
    explain_command: {
      description: "Parse and explain a complex shell command.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to explain.",
          },
        },
        required: ["command"] as const,
      } as const,
      execute: async ({ command }: { command: string }): Promise<any> => {
        try {
          const ast = parse(command);
          
          const wordToString = (word: any): string => {
            if (!word) return "";
            return word.parts.map((p: any) => p.value || "").join("");
          };

          const explain = (node: any): string => {
             if (node.type === "Script") return node.statements.map(explain).join("\n");
             if (node.type === "Statement") {
                let res = node.pipelines.map(explain).join(" | ");
                if (node.background) res += " (runs in background)";
                return res;
             }
             if (node.type === "Pipeline") {
                if (node.commands.length > 1) {
                   return `A pipeline of ${node.commands.length} commands:\n` + node.commands.map((c: any) => `  - ${explain(c)}`).join("\n");
                }
                return explain(node.commands[0]);
             }
             if (node.type === "SimpleCommand") {
                const name = wordToString(node.name);
                const args = node.args.map(wordToString).join(" ");
                let desc = `Executes '${name}'`;
                if (args) desc += ` with arguments: ${args}`;
                if (node.redirections && node.redirections.length > 0) {
                  desc += ` (with ${node.redirections.length} redirections)`;
                }
                return desc;
             }
             if (node.type === "FunctionDef") {
                return `Defines function '${node.name}'`;
             }
             return `Command of type ${node.type}`;
          };
          
          return {
            explanation: explain(ast),
            ast: JSON.parse(JSON.stringify(ast, (key, value) => key === "parent" ? undefined : value))
          };
        } catch (error: any) {
          return { error: `Failed to parse command: ${sanitizeErrorMessage(error.message)}` };
        }
      },
    },
    find_files: {
      description: "Search for files by name or glob pattern across the virtual filesystem.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the directory to start searching from.",
          },
          pattern: {
            type: "string",
            description: "Filename pattern or glob (e.g., '*.ts', 'config.*').",
          },
        },
        required: ["path", "pattern"] as const,
      } as const,
      execute: async ({ path, pattern }: { path: string; pattern: string }): Promise<any> => {
        try {
          const results: string[] = [];
          const regexPattern = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
          
          const walk = async (dir: string) => {
            const entries = await sandbox.fs.readdir(dir);
            for (const entry of entries) {
              const fullPath = dir === "/" ? `/${entry}` : `${dir}/${entry}`;
              try {
                const stat = await sandbox.fs.stat(fullPath);
                if (stat.isDirectory) {
                  await walk(fullPath);
                } else if (regexPattern.test(entry)) {
                  results.push(fullPath);
                }
              } catch { /* ignore individual file errors */ }
            }
          };

          await walk(path);
          return { results };
        } catch (error: any) {
          return { error: sanitizeErrorMessage(error.message) };
        }
      },
    },
    grep_search: {
      description: "Search for a text pattern across multiple files (like grep -r).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the directory to search in.",
          },
          query: {
            type: "string",
            description: "The text or regex pattern to search for.",
          },
          include: {
            type: "string",
            description: "Optional glob pattern for files to include (e.g., '*.sh').",
          },
        },
        required: ["path", "query"] as const,
      } as const,
      execute: async ({ path, query, include }: { path: string; query: string; include?: string }): Promise<any> => {
        try {
          const results: any[] = [];
          const searchRegex = new RegExp(query, "i");
          const includeRegex = include ? new RegExp("^" + include.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$") : null;
          
          const walk = async (dir: string) => {
            const entries = await sandbox.fs.readdir(dir);
            for (const entry of entries) {
              const fullPath = dir === "/" ? `/${entry}` : `${dir}/${entry}`;
              try {
                const stat = await sandbox.fs.stat(fullPath);
                if (stat.isDirectory) {
                  await walk(fullPath);
                } else if (!includeRegex || includeRegex.test(entry)) {
                  const content = await sandbox.fs.readFile(fullPath);
                  const lines = content.split("\n");
                  for (let i = 0; i < lines.length; i++) {
                    if (searchRegex.test(lines[i])) {
                      results.push({
                        path: fullPath,
                        line: i + 1,
                        content: lines[i].trim()
                      });
                      if (results.length > 100) break; // Limit results
                    }
                  }
                }
              } catch { /* ignore errors */ }
              if (results.length > 100) break;
            }
          };

          await walk(path);
          return { results };
        } catch (error: any) {
          return { error: sanitizeErrorMessage(error.message) };
        }
      },
    },
    check_environment: {
      description: "Get diagnostics about the sandboxed environment including limits and runtime state.",
      inputSchema: {
        type: "object",
        properties: {},
      } as const,
      execute: async (): Promise<any> => {
        try {
          const state = (sandbox as any).state;
          const limits = (sandbox as any).limits;
          
          return {
            cwd: state.cwd,
            env: Array.from(state.env.keys()),
            limits: {
              maxCommandCount: limits.maxCommandCount,
              maxCallDepth: limits.maxCallDepth,
              maxLoopIterations: limits.maxLoopIterations,
              cpuTimeout: limits.cpuTimeout,
            },
            usage: {
              commandCount: state.commandCount,
              uptime: Date.now() - state.startTime,
            },
            version: "Ag-Bash vNext (Alpha)",
            capabilities: [
              "Granular Tools",
              "Semantic Analysis",
              "Fuzzy Patching",
              "Recursive Search",
              "Multi-Runtime (JS/Python)"
            ]
          };
        } catch (error: any) {
          return { error: sanitizeErrorMessage(error.message) };
        }
      },
    },
    run_js: {
      description: "Execute JavaScript or TypeScript code in the sandbox using the internal js-exec runtime.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "The JavaScript/TypeScript code to execute.",
          },
          isModule: {
            type: "boolean",
            description: "Whether to run in ES module mode.",
          },
        },
        required: ["code"] as const,
      } as const,
      execute: async ({ code, isModule }: { code: string; isModule?: boolean }): Promise<any> => {
        const args = ["-c", code];
        if (isModule) args.unshift("-m");
        const result = await sandbox.exec(`js-exec ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`, { persistState: true });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode
        };
      },
    },
    run_python: {
      description: "Execute Python code in the sandbox using the internal python3 runtime.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "The Python code to execute.",
          },
        },
        required: ["code"] as const,
      } as const,
      execute: async ({ code }: { code: string }): Promise<any> => {
        const result = await sandbox.exec(`python3 -c "${code.replace(/"/g, '\\"')}"`, { persistState: true });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode
        };
      },
    },
    query_json: {
      description: "Run a jq query against a JSON file or string.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The jq filter/query string.",
          },
          path: {
            type: "string",
            description: "Optional path to a JSON file to query.",
          },
          json: {
            type: "string",
            description: "Optional JSON string to query directly.",
          },
        },
        required: ["query"] as const,
      } as const,
      execute: async ({ query, path, json }: { query: string; path?: string; json?: string }): Promise<any> => {
        let cmd = `echo '${(json || "").replace(/'/g, "'\\''")}' | jq '${query}'`;
        if (path) {
          cmd = `jq '${query}' ${path}`;
        }
        const result = await sandbox.exec(cmd);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode
        };
      },
    },
    diff_files: {
      description: "Generate a unified diff between two files.",
      inputSchema: {
        type: "object",
        properties: {
          file1: {
            type: "string",
            description: "Path to the first file.",
          },
          file2: {
            type: "string",
            description: "Path to the second file.",
          },
        },
        required: ["file1", "file2"] as const,
      } as const,
      execute: async ({ file1, file2 }: { file1: string; file2: string }): Promise<any> => {
        const result = await sandbox.exec(`diff -u ${file1} ${file2}`);
        return {
          diff: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode
        };
      },
    },
    help_builtin: {
      description: "Get detailed help for a shell builtin command.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The name of the builtin command (e.g., 'cd', 'declare').",
          },
        },
        required: ["command"] as const,
      } as const,
      execute: async ({ command }: { command: string }): Promise<any> => {
        const result = await sandbox.exec(`help ${command}`);
        return {
          help: result.stdout,
          stderr: result.stderr
        };
      },
    },
    run_command: {
      description: "Execute a shell command in the sandbox. Use this for general shell operations.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The full shell command to execute.",
          },
        },
        required: ["command"] as const,
      } as const,
      execute: async ({ command }: { command: string }): Promise<any> => {
        try {
          const result = await sandbox.exec(command);
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode
          };
        } catch (error: any) {
          return { error: sanitizeErrorMessage(error.message) };
        }
      },
    },
  };
}

/**
 * Suggest similar files when a file is not found.
 */
async function suggestSimilarFiles(sandbox: Bash, missingPath: string): Promise<string[] | undefined> {
  try {
    const parentDir = missingPath.split("/").slice(0, -1).join("/") || "/";
    const filename = missingPath.split("/").pop() || "";
    
    if (!(await sandbox.fs.exists(parentDir))) {
      return undefined;
    }

    const files = await sandbox.fs.readdir(parentDir);
    
    // Improved similarity check: common prefix or substring
    const suggestions = files.filter(f => {
      const fLower = f.toLowerCase();
      const mLower = filename.toLowerCase();
      return fLower.startsWith(mLower) || 
             mLower.startsWith(fLower) || 
             fLower.includes(mLower) || 
             mLower.includes(fLower) ||
             (fLower.length > 3 && mLower.length > 3 && (fLower.slice(0, 3) === mLower.slice(0, 3)));
    });

    return suggestions.length > 0 ? suggestions.map(s => {
      const p = `${parentDir}/${s}`.replace(/\/+/g, "/");
      return p.startsWith("/") ? p : `/${p}`;
    }) : undefined;
  } catch {
    return undefined;
  }
}
