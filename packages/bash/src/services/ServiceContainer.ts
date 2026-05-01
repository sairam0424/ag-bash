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
import { AgentMemory } from "./AgentMemory.js";
import { McpClient } from "./McpClient.js";
import { SessionManager } from "./SessionManager.js";
import { SharedStateBus } from "./SharedStateBus.js";
import { CronScheduler } from "./CronScheduler.js";
import { GitTracker } from "./GitTracker.js";
import { TaskManager } from "./TaskManager.js";
import { TeamManager } from "./TeamManager.js";
import { WorktreeManager } from "./WorktreeManager.js";

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

  taskManager.setBus(bus);
  teamManager.setBus(bus);
  gitTracker.setBus(bus);
  cronScheduler.setBus(bus);
  worktreeManager.setBus(bus);

  return {
    astCache: overrides?.astCache ?? new ASTCache(),
    sharedBus: bus,
    sessionManager: overrides?.sessionManager ?? new SessionManager(),
    agentManager: overrides?.agentManager ?? new AgentManager(),
    mcpClient: overrides?.mcpClient ?? new McpClient(),
    orchestrator: overrides?.orchestrator ?? new Orchestrator(),
    lspManager: overrides?.lspManager ?? new LSPManager(),
    taskManager,
    teamManager,
    agentMemory: overrides?.agentMemory ?? new AgentMemory(),
    gitTracker,
    cronScheduler,
    worktreeManager,
  };
}
