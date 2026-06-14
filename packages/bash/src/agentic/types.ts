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
 * Failure types that the auto-retry system can recognize and attempt to heal.
 */
export type RetryableFailureType =
  | "command_not_found"
  | "file_not_found"
  | "permission_denied"
  | "timeout";

/**
 * Configuration for the automatic retry/heal subsystem.
 */
export interface AutoRetryConfig {
  /** Whether active self-healing is enabled. */
  enabled: boolean;
  /** Maximum number of retry attempts before giving up. Default: 3 */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff. Default: 100 */
  baseDelayMs?: number;
  /** Which failure types are eligible for automatic retry. Default: ['command_not_found', 'file_not_found'] */
  retryable?: RetryableFailureType[];
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
  /**
   * Configuration for active self-healing: auto-retry with corrected commands.
   * When enabled, the healer will attempt to fix and re-execute failed commands
   * using heuristic-based correction (typo detection, path resolution, etc.).
   */
  autoRetry?: AutoRetryConfig;
}

/**
 * Result from a tool execution.
 */
export interface ToolResult<T = unknown> {
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
export type PermissionResult<TArgs = unknown> =
  | { behavior: "allow"; updatedInput?: TArgs }
  | { behavior: "deny"; message: string }
  | { behavior: "ask"; message: string };

/**
 * ToolboxTool definition with advanced lifecycle hooks and metadata.
 */
export interface ToolboxTool<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: import("zod").ZodType<TArgs>;

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
  execute: (bash: import("../Bash.js").Bash, args: TArgs) => Promise<TResult>;

  /**
   * Optional hook to validate input before execution.
   */
  validateInput: (args: unknown) => Promise<ValidationResult>;

  /**
   * Optional hook to check permissions before execution.
   */
  checkPermissions: (
    bash: import("../Bash.js").Bash,
    args: TArgs,
  ) => Promise<PermissionResult<TArgs>>;

  /**
   * Indicates if the tool is read-only (doesn't modify state).
   */
  isReadOnly?: ((args: TArgs) => boolean) | boolean;

  /**
   * Indicates if the tool is destructive (e.g., delete, overwrite).
   */
  isDestructive?: ((args: TArgs) => boolean) | boolean;

  /**
   * Indicates if the tool is safe to run in parallel.
   */
  isConcurrencySafe?: ((args: TArgs) => boolean) | boolean;
}
