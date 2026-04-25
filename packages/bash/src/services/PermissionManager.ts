/**
 * PermissionManager - Centralized permission control for Ag-Bash.
 *
 * Handles tool execution permissions, including interactive prompts.
 */

import type { Bash } from "../Bash.js";
import type { PermissionResult } from "../agentic/types.js";

export interface PermissionHandler {
  ask(message: string): Promise<boolean>;
}

export class PermissionManager {
  private handler?: PermissionHandler;

  constructor(handler?: PermissionHandler) {
    this.handler = handler;
  }

  setHandler(handler: PermissionHandler): void {
    this.handler = handler;
  }

  /**
   * Checks if a tool is allowed to execute.
   *
   * @param bash The Bash instance
   * @param toolName Name of the tool
   * @param args Tool arguments
   * @param checkFn Optional tool-specific check function
   */
  async checkPermission(
    bash: Bash,
    toolName: string,
    args: any,
    checkFn?: (bash: Bash, args: any) => Promise<PermissionResult>,
  ): Promise<PermissionResult> {
    // 1. Tool-specific logic first
    if (checkFn) {
      const result = await checkFn(bash, args);
      if (result.behavior !== "allow") {
        // If it's "ask", we handle it here if a handler is present
        if (result.behavior === "ask" && this.handler) {
          const granted = await this.handler.ask(result.message);
          return granted
            ? { behavior: "allow" }
            : { behavior: "deny", message: "Permission denied by user." };
        }
        return result;
      }
    }

    // 2. Default logic (e.g., plan mode restrictions)
    if (bash.getMode() === "plan") {
      const destructive = (args: any) => {
        // This is a bit redundant with tool definitions, but safe
        return false; 
      };
      // We'll refine this once we have better access to tool metadata here
    }

    return { behavior: "allow" };
  }
}
