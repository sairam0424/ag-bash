/**
 * ServiceContainer - Dependency injection container for Bash services.
 *
 * Replaces the singleton pattern used in v2.x with explicit instance
 * ownership. Each Bash instance creates its own ServiceContainer,
 * ensuring full isolation between shell instances.
 *
 * v5.0.0: Lazy initialization for all services except astCache and sharedBus.
 * Services are only instantiated on first access, reducing startup cost.
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
  parser: typeof TreeSitterParser;
  dispose(): Promise<void>;
}

export function createDefaultServices(
  overrides?: Partial<ServiceContainer>,
): ServiceContainer {
  // Eager services - universally needed
  const astCache = overrides?.astCache ?? new ASTCache();
  const sharedBus = overrides?.sharedBus ?? new SharedStateBus();

  // Lazy backing fields
  let _sessionManager: SessionManager | null =
    overrides?.sessionManager ?? null;
  let _agentManager: AgentManager | null = overrides?.agentManager ?? null;
  let _mcpClient: McpClient | null = overrides?.mcpClient ?? null;
  let _orchestrator: Orchestrator | null = overrides?.orchestrator ?? null;
  let _lspManager: LSPManager | null = overrides?.lspManager ?? null;
  let _taskManager: TaskManager | null = overrides?.taskManager ?? null;
  let _teamManager: TeamManager | null = overrides?.teamManager ?? null;
  let _agentMemory: AgentMemory | null = overrides?.agentMemory ?? null;
  let _gitTracker: GitTracker | null = overrides?.gitTracker ?? null;
  let _cronScheduler: CronScheduler | null = overrides?.cronScheduler ?? null;
  let _worktreeManager: WorktreeManager | null =
    overrides?.worktreeManager ?? null;
  let _parser: typeof TreeSitterParser | null = overrides?.parser ?? null;

  let disposed = false;

  return {
    astCache,
    sharedBus,

    get sessionManager(): SessionManager {
      _sessionManager ??= new SessionManager();
      return _sessionManager;
    },

    get agentManager(): AgentManager {
      _agentManager ??= new AgentManager();
      return _agentManager;
    },

    get mcpClient(): McpClient {
      _mcpClient ??= new McpClient();
      return _mcpClient;
    },

    get orchestrator(): Orchestrator {
      _orchestrator ??= new Orchestrator();
      return _orchestrator;
    },

    get lspManager(): LSPManager {
      _lspManager ??= new LSPManager();
      return _lspManager;
    },

    get taskManager(): TaskManager {
      if (!_taskManager) {
        _taskManager = new TaskManager();
        _taskManager.setBus(sharedBus);
      }
      return _taskManager;
    },

    get teamManager(): TeamManager {
      if (!_teamManager) {
        _teamManager = new TeamManager();
        _teamManager.setBus(sharedBus);
      }
      return _teamManager;
    },

    get agentMemory(): AgentMemory {
      _agentMemory ??= new AgentMemory();
      return _agentMemory;
    },

    get gitTracker(): GitTracker {
      if (!_gitTracker) {
        _gitTracker = new GitTracker();
        _gitTracker.setBus(sharedBus);
      }
      return _gitTracker;
    },

    get cronScheduler(): CronScheduler {
      if (!_cronScheduler) {
        _cronScheduler = new CronScheduler();
        _cronScheduler.setBus(sharedBus);
      }
      return _cronScheduler;
    },

    get worktreeManager(): WorktreeManager {
      if (!_worktreeManager) {
        _worktreeManager = new WorktreeManager();
        _worktreeManager.setBus(sharedBus);
      }
      return _worktreeManager;
    },

    get parser(): typeof TreeSitterParser {
      _parser ??= TreeSitterParser;
      return _parser;
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;

      const errors: Error[] = [];

      // Only dispose services that were actually instantiated
      const disposables: Array<{ dispose(): Promise<void> } | null> = [
        _cronScheduler,
        _gitTracker,
        _mcpClient,
        _sessionManager,
      ];

      for (const svc of disposables) {
        if (svc) {
          try {
            await svc.dispose();
          } catch (e: unknown) {
            errors.push(e instanceof Error ? e : new Error(String(e)));
          }
        }
      }

      sharedBus.destroy();

      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `Dispose failed for ${errors.length} service(s)`,
        );
      }
    },
  };
}
