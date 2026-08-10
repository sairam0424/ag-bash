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
import { TreeSitterParser } from "../parser/tree-sitter-parser.js";
import { AgentManager } from "./AgentManager.js";
import { AgentMemory } from "./AgentMemory.js";
import { CronScheduler } from "./CronScheduler.js";
import { GitTracker } from "./GitTracker.js";
import { McpClient } from "./McpClient.js";
import { SessionManager } from "./SessionManager.js";
import { SharedStateBus } from "./SharedStateBus.js";
import { TaskManager } from "./TaskManager.js";
import { TeamManager } from "./TeamManager.js";
import { WorktreeManager } from "./WorktreeManager.js";

/**
 * Interface for services that hold resources requiring explicit cleanup.
 */
export interface Disposable {
  dispose(): Promise<void>;
}

export interface ServiceContainer {
  astCache: ASTCache;
  sharedBus: SharedStateBus;
  sessionManager: SessionManager;
  agentManager: AgentManager;
  mcpClient: McpClient;
  orchestrator: Orchestrator;
  lspManager: LSPManager;
  taskManager: TaskManager;
  teamManager: TeamManager;
  agentMemory: AgentMemory;
  gitTracker: GitTracker;
  cronScheduler: CronScheduler;
  worktreeManager: WorktreeManager;
  parser: TreeSitterParser;
  dispose(): Promise<void>;
}

export function createDefaultServices(
  overrides?: Partial<ServiceContainer>,
): ServiceContainer {
  const bus = overrides?.sharedBus ?? new SharedStateBus();
  const taskManager = overrides?.taskManager ?? new TaskManager();
  const teamManager = overrides?.teamManager ?? new TeamManager();
  const gitTracker = overrides?.gitTracker ?? new GitTracker();
  const cronScheduler = overrides?.cronScheduler ?? new CronScheduler();
  const worktreeManager = overrides?.worktreeManager ?? new WorktreeManager();
  const sessionManager = overrides?.sessionManager ?? new SessionManager();
  const mcpClient = overrides?.mcpClient ?? new McpClient();
  const parser = overrides?.parser ?? new TreeSitterParser();

  taskManager.setBus(bus);
  teamManager.setBus(bus);
  gitTracker.setBus(bus);
  cronScheduler.setBus(bus);
  worktreeManager.setBus(bus);

  let disposed = false;

  const services: ServiceContainer = {
    astCache: overrides?.astCache ?? new ASTCache(),
    sharedBus: bus,
    sessionManager,
    agentManager: overrides?.agentManager ?? new AgentManager(),
    mcpClient,
    orchestrator: overrides?.orchestrator ?? new Orchestrator(),
    lspManager: overrides?.lspManager ?? new LSPManager(),
    taskManager,
    teamManager,
    agentMemory: overrides?.agentMemory ?? new AgentMemory(),
    gitTracker,
    cronScheduler,
    worktreeManager,
    parser,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;

      // Dispose in reverse creation order. Each service's dispose is
      // idempotent and handles its own error boundaries.
      await cronScheduler.dispose();
      await gitTracker.dispose();
      await mcpClient.dispose();
      await sessionManager.dispose();
      bus.destroy();
    },
  };

  return services;
}
