/**
 * ServiceContainer - Dependency injection container for Bash services.
 *
 * Replaces the singleton pattern used in v2.x with explicit instance
 * ownership. Each Bash instance creates its own ServiceContainer,
 * ensuring full isolation between shell instances.
 */

import { Orchestrator } from "../agentic/Orchestrator.js";
import { LSPManager } from "../lsp/LSPManager.js";
import { ASTCache } from "../parser/ASTCache.js";
import { AgentManager } from "./AgentManager.js";
import { McpClient } from "./McpClient.js";
import { SessionManager } from "./SessionManager.js";
import { SharedStateBus } from "./SharedStateBus.js";

export interface ServiceContainer {
  astCache: ASTCache;
  sharedBus: SharedStateBus;
  sessionManager: SessionManager;
  agentManager: AgentManager;
  mcpClient: McpClient;
  orchestrator: Orchestrator;
  lspManager: LSPManager;
}

export function createDefaultServices(
  overrides?: Partial<ServiceContainer>,
): ServiceContainer {
  return {
    astCache: overrides?.astCache ?? new ASTCache(),
    sharedBus: overrides?.sharedBus ?? new SharedStateBus(),
    sessionManager: overrides?.sessionManager ?? new SessionManager(),
    agentManager: overrides?.agentManager ?? new AgentManager(),
    mcpClient: overrides?.mcpClient ?? new McpClient(),
    orchestrator: overrides?.orchestrator ?? new Orchestrator(),
    lspManager: overrides?.lspManager ?? new LSPManager(),
  };
}
