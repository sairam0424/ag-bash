/**
 * Tool Execution Engine
 *
 * Orchestrates the tool execution lifecycle: validation -> permissions -> execution.
 * Handles resource governance (result size limits) and lifecycle events.
 */

import type { Bash } from "../../Bash.js";
import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import type { ToolboxTool } from "../Tool.js";

const MAX_TOOL_RESULT_SIZE = 100_000;
const ARTIFACT_DIR = "/.ag-bash/artifacts";

/**
 * Orchestrates the tool execution lifecycle:
 * validation -> permissions -> execution.
 */
export async function executeTool(
  bash: Bash,
  toolName: string,
  args: Record<string, unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool registry — the Map holds tools with differing TArgs/TResult; the existential <any, any> is the documented dispatch boundary (zod safeParse narrows at runtime in validateInput before execute is called).
  tools: Map<string, ToolboxTool<any, any>>,
): Promise<unknown> {
  const tool = tools.get(toolName);
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

  // @banned-pattern-ignore: args comes from Zod-validated tool input, never user-controlled keys
  let effectiveArgs: Record<string, unknown> = args;
  if (permission.behavior === "allow" && permission.updatedInput) {
    effectiveArgs = permission.updatedInput as Record<string, unknown>;
  }

  // 3. Lifecycle Events (Start)
  const startTime = Date.now();
  bash.emit("tool:start", { name: toolName, args: effectiveArgs });

  // 4. Execute
  let result: unknown;
  try {
    result = await tool.execute(bash, effectiveArgs);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    result = `Execution Error in ${toolName}: ${sanitizeErrorMessage(message)}`;
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
