/**
 * Interface for LLM-based troubleshooting.
 * Allows the host environment to provide AI-powered diagnostics.
 */
export interface LLMProvider {
  /**
   * Generates a diagnostic suggestion based on the failure context.
   */
  generateSuggestion(context: string): Promise<string | null>;
}

/**
 * Configuration for the Agentic Healer.
 */
export interface AgenticHealerConfig {
  /**
   * If true, enables heuristic-based local diagnostics.
   * Default: true
   */
  enableHeuristics?: boolean;
  /**
   * Optional LLM provider for advanced troubleshooting.
   */
  llm?: LLMProvider;
  /**
   * If true, the healer may attempt to automatically fix and re-run simple typos.
   * Default: false
   */
  allowAutoFix?: boolean;
}

/**
 * Result from a tool execution.
 */
export interface ToolResult<T = any> {
  data: T;
  /**
   * Optional message to display to the user/model alongside the data.
   */
  message?: string;
}

/**
 * Validation result for tool inputs.
 */
export type ValidationResult =
  | { result: true }
  | {
      result: false;
      message: string;
      errorCode?: number;
    };

/**
 * Permission result for tool execution.
 */
export type PermissionResult =
  | { behavior: "allow"; updatedInput?: any }
  | { behavior: "deny"; message: string }
  | { behavior: "ask"; message: string };

/**
 * ToolboxTool definition with advanced lifecycle hooks and metadata.
 */
export interface ToolboxTool {
  name: string;
  description: string;
  parameters: import("zod").ZodType<any>;
  
  /**
   * Optional aliases for backwards compatibility.
   */
  aliases?: string[];
  
  /**
   * Metadata for tool discovery and search.
   */
  searchHint?: string;

  /**
   * Maximum size in characters for tool result before it gets persisted.
   */
  maxResultSizeChars?: number;

  /**
   * Implementation of the tool logic.
   */
  execute: (bash: any, args: any, onProgress?: (progress: any) => void) => Promise<any>;

  /**
   * Optional hook to validate input before execution.
   */
  validateInput?: (
    bash: any,
    args: any,
  ) => Promise<ValidationResult>;

  /**
   * Optional hook to check permissions before execution.
   */
  checkPermissions?: (
    bash: any,
    args: any,
  ) => Promise<PermissionResult>;


  /**
   * Indicates if the tool is read-only (doesn't modify state).
   */
  isReadOnly?: (args: any) => boolean;

  /**
   * Indicates if the tool is destructive (e.g., delete, overwrite).
   */
  isDestructive?: (args: any) => boolean;

  /**
   * Indicates if the tool is safe to run in parallel.
   */
  isConcurrencySafe?: (args: any) => boolean;
}
