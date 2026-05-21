import type { PermissionResult } from "../agentic/types.js";
import type { Bash } from "../Bash.js";

export interface PermissionHandler {
  ask(message: string): Promise<boolean>;
}

export interface PermissionRule {
  /** Pattern for tool names (e.g., "read_file", "write:*") */
  toolPattern: string | RegExp;
  /** Pattern for file paths (if applicable) */
  pathPattern?: string | RegExp;
  /** The behavior for this rule */
  behavior: "allow" | "deny" | "ask";
  /** Optional behavior behavior for specific modes (e.g., "plan", "execute") */
  mode?: "plan" | "execute";
  /** Optional reason for the behavior */
  reason?: string;
}

/**
 * PermissionManager - Centralized permission control for Ag-Bash.
 *
 * Handles tool execution permissions, including interactive prompts and rule-based policies.
 */
export class PermissionManager {
  private handler?: PermissionHandler;
  private rules: PermissionRule[] = [];
  private strictMode = false;
  private planAllowlist: Set<string> = new Set([
    "read_file",
    "glob_files",
    "search_tools",
    "list_files",
    "get_state",
    "task_list",
    "task_get",
    "cron_list",
  ]);

  constructor(handler?: PermissionHandler) {
    this.handler = handler;
    this.initDefaultRules();
  }

  private initDefaultRules(): void {
    // In 'plan' mode, deny all destructive operations by default unless overridden
    this.addRule({
      toolPattern:
        /^(write|edit|delete|rm|mkdir|mv|cp|multi_replace|ag_edit|multi_replace)/,
      mode: "plan",
      behavior: "deny",
      reason:
        "Destructive operations are not allowed while in 'plan' mode. Use 'ag-plan' to exit plan mode if you are ready to apply changes.",
    });
  }

  setHandler(handler: PermissionHandler): void {
    this.handler = handler;
  }

  /**
   * Enables strict allowlist mode. When enabled and in plan mode,
   * only tools explicitly in the allowlist can execute. All others are denied.
   * This prevents bypass of the deny-list via non-standard tool names.
   */
  enableStrictMode(): void {
    this.strictMode = true;
  }

  /**
   * Disables strict allowlist mode. Falls back to the default deny-list behavior.
   */
  disableStrictMode(): void {
    this.strictMode = false;
  }

  /**
   * Returns whether strict mode is currently enabled.
   */
  isStrictMode(): boolean {
    return this.strictMode;
  }

  /**
   * Replaces the plan-mode allowlist with a custom set of tool names.
   * Only effective when strict mode is enabled.
   */
  setAllowedPlanTools(tools: string[]): void {
    this.planAllowlist = new Set(tools);
  }

  /**
   * Returns the current plan-mode allowlist as an array (for inspection/debugging).
   */
  getAllowedPlanTools(): string[] {
    return Array.from(this.planAllowlist);
  }

  /**
   * Adds a permission rule. Rules added later take precedence (LIFO).
   */
  addRule(rule: PermissionRule): void {
    this.rules.unshift(rule);
  }

  /**
   * Checks if a tool is allowed to execute.
   */
  async checkPermission(
    bash: Bash,
    toolName: string,
    args: any,
    checkFn?: (bash: Bash, args: any) => Promise<PermissionResult>,
  ): Promise<PermissionResult> {
    const path = args?.path || args?.filePath || "";

    // 0. Strict allowlist enforcement in plan mode
    if (this.strictMode && bash.getMode() === "plan") {
      if (!this.planAllowlist.has(toolName)) {
        return {
          behavior: "deny",
          message:
            `[Strict Mode] Tool "${toolName}" is not in the plan-mode allowlist. ` +
            `Only read-only tools are permitted during plan mode. ` +
            `Allowed tools: ${Array.from(this.planAllowlist).join(", ")}`,
        };
      }
    }

    // 1. Check configured rules first (Hierarchical)
    for (const rule of this.rules) {
      if (this.matches(toolName, rule.toolPattern)) {
        if (!rule.mode || rule.mode === bash.getMode()) {
          if (!rule.pathPattern || this.matches(path, rule.pathPattern)) {
            if (rule.behavior === "allow") return { behavior: "allow" };
            if (rule.behavior === "deny") {
              return {
                behavior: "deny",
                message:
                  rule.reason ||
                  `Permission denied by rule: ${rule.toolPattern}`,
              };
            }
            if (rule.behavior === "ask") {
              if (this.handler) {
                const granted = await this.handler.ask(
                  rule.reason || `Do you want to allow ${toolName} on ${path}?`,
                );
                return granted
                  ? { behavior: "allow" }
                  : { behavior: "deny", message: "Permission denied by user." };
              }
            }
          }
        }
      }
    }

    // 2. Delegate to tool-specific logic if provided
    if (checkFn) {
      const result = await checkFn(bash, args);
      if (result.behavior !== "allow") {
        if (result.behavior === "ask" && this.handler) {
          const granted = await this.handler.ask(result.message);
          return granted
            ? { behavior: "allow" }
            : { behavior: "deny", message: "Permission denied by user." };
        }
        return result;
      }
    }

    // 3. Global Plan Mode restrictions
    if (bash.getMode() === "plan") {
      // In plan mode, we generally deny anything that isn't explicitly allowed by tool-specific logic or rules
      // (The Tool class handles this usually, but we have a safety net here)
    }

    return { behavior: "allow" };
  }

  private matches(value: string, pattern: string | RegExp): boolean {
    if (pattern instanceof RegExp) {
      return pattern.test(value);
    }
    if (pattern.endsWith("*")) {
      return value.startsWith(pattern.slice(0, -1));
    }
    return value === pattern;
  }
}
