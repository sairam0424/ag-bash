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
 * Bytes of entropy in the per-realm artifact token, rendered as fixed-width
 * hex. Fixed width matters: `Math.random().toString(36).substring(2, 10)` does
 * NOT reliably yield 8 characters, because a small float has a short base-36
 * expansion — `(0.5).toString(36)` is `"0.i"`, whose `substring(2, 10)` is the
 * single character `"i"`. Over 2e6 samples that degenerate case shows up, so
 * the real id space was smaller than the 8-character name suggested.
 */
const ARTIFACT_TOKEN_BYTES = 8;

/**
 * Bounded redraws when a candidate spill path is already occupied. Spills from
 * this realm can never need a redraw (the sequence below makes them unique), so
 * this only fires when a writer outside this realm already holds the name.
 */
const ARTIFACT_PATH_ATTEMPTS = 8;

/**
 * Monotonic spill counter shared by every `Bash` in this realm — including
 * sibling sub-agents, which `AgentManager.spawn()` creates in-process against
 * CoW overlays that are later merged into one parent filesystem.
 *
 * `+= 1` followed by a read is a single synchronous step. JavaScript runs each
 * job to completion, so two spills cannot observe the same value no matter how
 * they interleave at `await` points. That is what makes the path unique by
 * construction rather than merely improbable.
 */
let artifactSequence = 0;

/** Memoised per-realm token, distinguishing this realm's spills from others'. */
let artifactSessionToken: string | undefined;

/** Fixed-width lowercase hex drawn from the best available CSPRNG. */
function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    // Browser/older-runtime fallback. Weaker, which is precisely why the
    // sequence — not this value — carries the uniqueness guarantee.
    for (let index = 0; index < byteCount; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function artifactToken(): string {
  if (artifactSessionToken === undefined) {
    artifactSessionToken = randomHex(ARTIFACT_TOKEN_BYTES);
  }
  return artifactSessionToken;
}

/**
 * Reserves a spill path for `toolName`.
 *
 * Uniqueness has two independent layers:
 *  - within this realm, the monotonic `artifactSequence` guarantees distinct
 *    names outright, closing the collision for sibling sub-agents;
 *  - across realms, the per-realm token supplies 64 bits so two processes
 *    sharing one ARTIFACT_DIR do not converge on a name.
 *
 * The existence probe is defence in depth for the cross-realm case (and for the
 * `Math.random` fallback above), and it is NOT atomic: on a filesystem shared
 * with another process, that process could create the file between the probe
 * and the write. That residual window is acceptable here only because it is not
 * what this function relies on — the sequence already excludes every in-realm
 * spill, which is the whole sub-agent trust boundary. `toolName` is safe to
 * interpolate because `executeTool` has already resolved it against the
 * registered tool map before reaching here.
 */
async function reserveArtifactPath(
  bash: Bash,
  toolName: string,
): Promise<string> {
  for (let attempt = 0; attempt < ARTIFACT_PATH_ATTEMPTS; attempt += 1) {
    artifactSequence += 1;
    const sequence = artifactSequence;
    // Fresh entropy on every redraw, so a foreign collision cannot repeat.
    const redraw = attempt === 0 ? "" : `-${randomHex(ARTIFACT_TOKEN_BYTES)}`;
    const candidate = `${ARTIFACT_DIR}/${toolName}_${artifactToken()}-${sequence.toString(36)}${redraw}.txt`;
    if (!(await bash.fs.exists(candidate))) {
      return candidate;
    }
  }
  // Fail closed. Losing an oversized result is strictly better than handing one
  // caller a path that already holds another caller's tool output.
  throw new Error(
    `Unable to reserve a unique artifact path for tool '${toolName}' after ${ARTIFACT_PATH_ATTEMPTS} attempts.`,
  );
}

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
    await bash.fs.mkdir(ARTIFACT_DIR, { recursive: true });
    const artifactPath = await reserveArtifactPath(bash, toolName);
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
