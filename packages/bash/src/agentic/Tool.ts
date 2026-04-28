import type { z } from "zod";
import type { Bash } from "../Bash.js";
import type { PermissionResult, ValidationResult } from "./types.js";

/**
 * Metadata for a tool.
 */
export interface ToolMetadata {
  name: string;
  description: string;
  parameters: z.ZodType<any>;
  isReadOnly?: ((args: any) => boolean) | boolean;
  isDestructive?: ((args: any) => boolean) | boolean;
  isConcurrencySafe?: ((args: any) => boolean) | boolean;
  searchHint?: string;
  aliases?: string[];
  maxResultSizeChars?: number;
  /** Reasoning effort level applied as a context modifier for subsequent turns */
  effort?: "low" | "medium" | "high";
  /** Advanced composition hooks for the orchestration layer */
  composeHooks?: { before?: string[]; after?: string[]; parallel?: string[] };
}

/**
 * Base interface for all agentic tools.
 */
export interface ToolboxTool extends ToolMetadata {
  checkPermissions: (bash: Bash, args: any) => Promise<PermissionResult>;
  validateInput: (args: any) => Promise<ValidationResult>;
  execute: (bash: Bash, args: any) => Promise<any>;
}

/**
 * Abstract base class for tools providing common functionality.
 */
export abstract class Tool implements ToolboxTool {
  abstract name: string;
  abstract description: string;
  abstract parameters: z.ZodObject<any>;

  isReadOnly: ((args: any) => boolean) | boolean = false;
  isDestructive: ((args: any) => boolean) | boolean = false;
  isConcurrencySafe: ((args: any) => boolean) | boolean = false;
  searchHint?: string;
  aliases?: string[];

  async checkPermissions(bash: Bash, _args: any): Promise<PermissionResult> {
    // Default: allow but respect bash mode
    if (this.isDestructive && bash.getMode() === "plan") {
      return {
        behavior: "deny",
        message: `Cannot execute destructive tool '${this.name}' in plan mode.`,
      };
    }
    return { behavior: "allow" };
  }

  async validateInput(args: any): Promise<ValidationResult> {
    const result = this.parameters.safeParse(args);
    if (!result.success) {
      return {
        result: false,
        message: `Invalid parameters for '${this.name}': ${result.error.message}`,
      };
    }
    return { result: true };
  }

  abstract execute(bash: Bash, args: any): Promise<any>;

  /**
   * Helper to truncate long results for token efficiency.
   */
  protected truncateResult(result: string, maxLength = 50000): string {
    if (result.length > maxLength) {
      return `${result.substring(0, maxLength)}\n... [Result truncated]`;
    }
    return result;
  }
}

/**
 * Factory function to build a tool from a plain object.
 * Breaks circular dependencies by living in the base Tool file.
 */
export function buildTool(
  tool: Partial<ToolboxTool> &
    Pick<ToolboxTool, "name" | "description" | "parameters" | "execute">,
): ToolboxTool {
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
      (async (bash: Bash, args: any) => {
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
      (async (args: any) => {
        const result = tool.parameters.safeParse(args);
        if (!result.success) {
          return {
            result: false,
            message: `Invalid parameters for '${tool.name}': ${result.error.message}`,
          };
        }
        return { result: true };
      }),
  } as ToolboxTool;
}
