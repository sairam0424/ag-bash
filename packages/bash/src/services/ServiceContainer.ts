/**
 * ServiceContainer - Dependency injection container for Bash services.
 *
 * Replaces the singleton pattern used in v2.x with explicit instance
 * ownership. Each Bash instance creates its own ServiceContainer,
 * ensuring full isolation between shell instances.
 *
 * v5.0.0: Lazy initialization for all services except astCache and sharedBus.
 * Services are only instantiated on first access, reducing startup cost.
 *
 * v6.0.0: Descriptor-registry model. Each lazy service is described by a
 * {@link ServiceDescriptor} carrying metadata (bus-aware, disposable). The
 * registry centralizes bus wiring and ensures dispose() iterates EVERY
 * instantiated disposable instead of a hardcoded subset. AgentMemory is
 * hydrated from / persisted to the VFS via an optional fs accessor.
 */

import { Orchestrator } from "../agentic/Orchestrator.js";
import { LSPManager } from "../lsp/LSPManager.js";
import { ASTCache } from "../parser/ASTCache.js";
import { TreeSitterParser } from "../parser/tree-sitter-parser.js";
import { AgentManager } from "./AgentManager.js";
import { AgentMemory } from "./AgentMemory.js";
import {
  loadMemoryFromFs,
  type SyncFs,
  saveMemoryToFs,
} from "./AgentMemorySync.js";
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
  /**
   * Guarantee the AgentMemory instance has finished hydrating from the VFS.
   * Synchronous `agentMemory` access returns an instance immediately and
   * kicks off hydration in the background; callers that need a
   * guaranteed-loaded store should await this. Resolves immediately (no-op)
   * when no fs accessor was supplied or hydration already completed.
   */
  ensureAgentMemoryHydrated(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * A bus-aware service exposes `setBus` so the container can centrally wire it
 * to the shared state bus on construction.
 */
interface BusAware {
  setBus(bus: SharedStateBus): void;
}

/**
 * A disposable service exposes an async `dispose` for deterministic cleanup.
 */
interface Disposable {
  dispose(): Promise<void>;
}

/**
 * Per-service descriptor used by the registry. `getInstance` returns the
 * already-constructed backing instance WITHOUT triggering lazy construction
 * (so dispose() never instantiates a service merely to dispose it).
 */
interface ServiceDescriptor {
  readonly key: string;
  readonly isBusAware: boolean;
  readonly isDisposable: boolean;
  /** Returns the current backing instance, or null if never instantiated. */
  getInstance(): object | null;
}

export function createDefaultServices(
  overrides?: Partial<ServiceContainer>,
  fsAccessor?: () => SyncFs,
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

  // Memoized AgentMemory hydration promise. Created on first agentMemory
  // access (when an fsAccessor is present) and awaited by
  // ensureAgentMemoryHydrated().
  let _agentMemoryHydration: Promise<void> | null = null;

  let disposed = false;

  /**
   * Centralized lazy-construction helper for bus-aware services. Wires the
   * shared bus exactly once, on construction, replacing the previous five
   * ad-hoc `setBus` call sites.
   */
  function wireBus<T extends BusAware>(instance: T): T {
    instance.setBus(sharedBus);
    return instance;
  }

  function ensureAgentMemoryInstance(): AgentMemory {
    if (_agentMemory) return _agentMemory;
    _agentMemory = new AgentMemory();
    // Kick off (memoized) hydration in the background when an fs accessor is
    // available. Failures degrade gracefully - loadMemoryFromFs already
    // tolerates missing scope dirs and corrupt files.
    if (fsAccessor && !_agentMemoryHydration) {
      const memory = _agentMemory;
      _agentMemoryHydration = (async (): Promise<void> => {
        try {
          await loadMemoryFromFs(memory, fsAccessor());
        } catch {
          // Hydration is best-effort; never block on a broken VFS.
        }
      })();
    }
    return _agentMemory;
  }

  // The descriptor registry. Order matters: dispose() iterates in reverse to
  // tear down in reverse construction order (mirrors the prior behavior).
  const registry: readonly ServiceDescriptor[] = [
    {
      key: "sessionManager",
      isBusAware: false,
      isDisposable: true,
      getInstance: (): object | null => _sessionManager,
    },
    {
      key: "agentManager",
      isBusAware: false,
      isDisposable: false,
      getInstance: (): object | null => _agentManager,
    },
    {
      key: "mcpClient",
      isBusAware: false,
      isDisposable: true,
      getInstance: (): object | null => _mcpClient,
    },
    {
      key: "orchestrator",
      isBusAware: false,
      isDisposable: false,
      getInstance: (): object | null => _orchestrator,
    },
    {
      key: "lspManager",
      isBusAware: false,
      isDisposable: false,
      getInstance: (): object | null => _lspManager,
    },
    {
      key: "taskManager",
      isBusAware: true,
      isDisposable: false,
      getInstance: (): object | null => _taskManager,
    },
    {
      key: "teamManager",
      isBusAware: true,
      isDisposable: false,
      getInstance: (): object | null => _teamManager,
    },
    {
      key: "agentMemory",
      isBusAware: false,
      isDisposable: false,
      getInstance: (): object | null => _agentMemory,
    },
    {
      key: "gitTracker",
      isBusAware: true,
      isDisposable: true,
      getInstance: (): object | null => _gitTracker,
    },
    {
      key: "cronScheduler",
      isBusAware: true,
      isDisposable: true,
      getInstance: (): object | null => _cronScheduler,
    },
    {
      key: "worktreeManager",
      isBusAware: true,
      isDisposable: false,
      getInstance: (): object | null => _worktreeManager,
    },
  ];

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
      _taskManager ??= wireBus(new TaskManager());
      return _taskManager;
    },

    get teamManager(): TeamManager {
      _teamManager ??= wireBus(new TeamManager());
      return _teamManager;
    },

    get agentMemory(): AgentMemory {
      return ensureAgentMemoryInstance();
    },

    get gitTracker(): GitTracker {
      _gitTracker ??= wireBus(new GitTracker());
      return _gitTracker;
    },

    get cronScheduler(): CronScheduler {
      _cronScheduler ??= wireBus(new CronScheduler());
      return _cronScheduler;
    },

    get worktreeManager(): WorktreeManager {
      _worktreeManager ??= wireBus(new WorktreeManager());
      return _worktreeManager;
    },

    get parser(): typeof TreeSitterParser {
      _parser ??= TreeSitterParser;
      return _parser;
    },

    async ensureAgentMemoryHydrated(): Promise<void> {
      // Constructing the instance also schedules hydration (when an fs
      // accessor is present), so ensure it exists first.
      ensureAgentMemoryInstance();
      if (_agentMemoryHydration) {
        await _agentMemoryHydration;
      }
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;

      const errors: Error[] = [];

      // Persist AgentMemory before tearing down, if it was instantiated and an
      // fs accessor is available. Wait for any in-flight hydration first so we
      // never save a partially-loaded store over good data.
      if (_agentMemory && fsAccessor) {
        try {
          if (_agentMemoryHydration) {
            await _agentMemoryHydration;
          }
          await saveMemoryToFs(_agentMemory, fsAccessor());
        } catch (e: unknown) {
          errors.push(e instanceof Error ? e : new Error(String(e)));
        }
      }

      // Dispose every instantiated disposable, in reverse construction order.
      for (const descriptor of [...registry].reverse()) {
        if (!descriptor.isDisposable) continue;
        const instance = descriptor.getInstance();
        if (!instance) continue;
        try {
          await (instance as Disposable).dispose();
        } catch (e: unknown) {
          errors.push(e instanceof Error ? e : new Error(String(e)));
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
