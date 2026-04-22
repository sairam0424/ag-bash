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
      description: "Apply one or more text patches to a file. Each patch replaces 'oldText' with 'newText'.",
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
              // Try normalized matching if exact fails (basic normalization)
              const normalizedContent = content.replace(/\r\n/g, "\n");
              const normalizedOld = patch.oldText.replace(/\r\n/g, "\n");
              
              if (normalizedContent.includes(normalizedOld)) {
                content = normalizedContent.replace(normalizedOld, patch.newText.replace(/\r\n/g, "\n"));
              } else {
                return { 
                  error: `Could not find exact match for patch in ${path}`,
                  failedPatch: patch.oldText,
                  context: "The text to be replaced must match exactly. Please check whitespace and line endings."
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
