import type { z } from "zod";
import type { Bash } from "../Bash.js";
import type { PermissionResult, ValidationResult } from "./types.js";

/**
 * Metadata for a tool.
 */
export interface ToolMetadata<TArgs = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TArgs>;
  isReadOnly?: ((args: TArgs) => boolean) | boolean;
  isDestructive?: ((args: TArgs) => boolean) | boolean;
  isConcurrencySafe?: ((args: TArgs) => boolean) | boolean;
  searchHint?: string;
  aliases?: string[];
  maxResultSizeChars?: number;
  /** Reasoning effort level applied as a context modifier for subsequent turns */
  effort?: "low" | "medium" | "high";
  /** Advanced composition hooks for the orchestration layer */
  composeHooks?: { before?: string[]; after?: string[]; parallel?: string[] };
  /** If true, only name + description are loaded initially; full schema is loaded on first use */
  deferred?: boolean;
  /** Callback to load the full Zod schema on demand (used with deferred: true) */
  loadSchema?: () => Promise<z.ZodType<TArgs>>;
}

/**
 * Base interface for all agentic tools.
 */
export interface ToolboxTool<TArgs = unknown, TResult = unknown>
  extends ToolMetadata<TArgs> {
  checkPermissions: (
    bash: Bash,
    args: TArgs,
  ) => Promise<PermissionResult<TArgs>>;
  validateInput: (args: unknown) => Promise<ValidationResult>;
  execute: (bash: Bash, args: TArgs) => Promise<TResult>;
}

/**
 * Factory function to build a tool from a plain object.
 * Breaks circular dependencies by living in the base Tool file.
 */
export function buildTool<TArgs = unknown, TResult = unknown>(
  tool: Partial<ToolboxTool<TArgs, TResult>> &
    Pick<
      ToolboxTool<TArgs, TResult>,
      "name" | "description" | "parameters" | "execute"
    >,
): ToolboxTool<TArgs, TResult> {
  const isDestructive =
    typeof tool.isDestructive === "function"
      ? tool.isDestructive
      : () => !!tool.isDestructive;

  return {
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    ...tool,
    checkPermissions:
      tool.checkPermissions ||
      (async (bash: Bash, args: TArgs) => {
        if (isDestructive(args) && bash.getMode() === "plan") {
          return {
            behavior: "deny",
            message: `Cannot execute destructive tool '${tool.name}' in plan mode.`,
          };
        }
        return { behavior: "allow" };
      }),
    validateInput:
      tool.validateInput ||
      (async (args: unknown) => {
        const result = tool.parameters.safeParse(args);
        if (!result.success) {
          return {
            result: false,
            message: `Invalid parameters for '${tool.name}': ${result.error.message}`,
          };
        }
        return { result: true };
      }),
  } as ToolboxTool<TArgs, TResult>;
}
