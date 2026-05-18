// AST types (for plugin authors)

export type { SearchResult } from "./agentic/ToolSearchEngine.js";
export { ToolSearchEngine } from "./agentic/ToolSearchEngine.js";
// AI Tool integration
export { type CreateBashToolOptions, createBashTool } from "./ai.js";
export type {
  CommandNode,
  PipelineNode,
  ScriptNode,
  SimpleCommandNode,
  StatementNode,
  WordNode,
} from "./ast/types.js";
export type {
  BashLogger,
  BashOptions,
  ExecOptions,
  JavaScriptConfig,
} from "./Bash.js";
export { Bash } from "./Bash.js";
export type {
  AllCommandName,
  CommandName,
  JavaScriptCommandName,
  NetworkCommandName,
  PythonCommandName,
} from "./commands/registry.js";
export {
  getCommandNames,
  getJavaScriptCommandNames,
  getNetworkCommandNames,
  getPythonCommandNames,
} from "./commands/registry.js";
// Custom commands API
export type { CustomCommand, LazyCommand } from "./custom-commands.js";
export { defineCommand } from "./custom-commands.js";
export { InMemoryFs } from "./fs/in-memory-fs/index.js";
export type {
  BufferEncoding,
  CpOptions,
  DirectoryEntry,
  FileContent,
  FileEntry,
  FileInit,
  FileSystemFactory,
  FsEntry,
  FsStat,
  InitialFiles,
  LazyFileEntry,
  LazyFileProvider,
  MkdirOptions,
  RmOptions,
  SymlinkEntry,
} from "./fs/interface.js";
export {
  MountableFs,
  type MountableFsOptions,
  type MountConfig,
} from "./fs/mountable-fs/index.js";
export { OverlayFs, type OverlayFsOptions } from "./fs/overlay-fs/index.js";
export {
  ReadWriteFs,
  type ReadWriteFsOptions,
} from "./fs/read-write-fs/index.js";
export { DebuggerBridge } from "./interpreter/index.js";
export type {
  CallStackState,
  CompletionSpec,
  ControlFlowState,
  ExpansionState,
  InterpreterContext,
  InterpreterState,
  IOState,
  LocalScopingState,
  ProcessState,
  ShellOptions,
  ShoptOptions,
  VariableAttributeState,
} from "./interpreter/types.js";
export { SemanticEngine } from "./lsp/semantic-engine.js";
export type {
  AllowedUrl,
  AllowedUrlEntry,
  NetworkConfig,
  RequestTransform,
  SecureFetch,
} from "./network/index.js";
export {
  NetworkAccessDeniedError,
  RedirectNotAllowedError,
  TooManyRedirectsError,
} from "./network/index.js";
export type { CacheEntry } from "./network/WebCache.js";
// Phase 4 modules
export { WebCache } from "./network/WebCache.js";
// Parser
export { parse } from "./parser/parser.js";
export type {
  CommandFinished as SandboxCommandFinished,
  OutputMessage,
  SandboxOptions,
  WriteFilesInput,
} from "./sandbox/index.js";
// AG Sandbox API compatible exports
export { Command as SandboxCommand, Sandbox } from "./sandbox/index.js";
export type { DestructiveWarning } from "./security/destructive-command-detector.js";
export { detectDestructiveCommand } from "./security/destructive-command-detector.js";
// Security module - defense-in-depth
export type {
  DefenseInDepthConfig,
  DefenseInDepthHandle,
  DefenseInDepthStats,
  SecurityViolation,
  SecurityViolationType,
} from "./security/index.js";
export {
  createConsoleViolationCallback,
  DefenseInDepthBox,
  SecurityViolationError,
  SecurityViolationLogger,
} from "./security/index.js";
export type { MemoryEntry, MemoryScope } from "./services/AgentMemory.js";
export { AgentMemory } from "./services/AgentMemory.js";
export {
  loadMemoryFromFs,
  saveMemoryToFs,
  syncAgentMemory,
} from "./services/AgentMemorySync.js";
export type { CronJob } from "./services/CronScheduler.js";
export { CronScheduler } from "./services/CronScheduler.js";
export type { GitOperation } from "./services/GitTracker.js";
export { GitTracker } from "./services/GitTracker.js";
// Service container (v3.0 dependency injection)
export type { ServiceContainer } from "./services/ServiceContainer.js";
export { createDefaultServices } from "./services/ServiceContainer.js";
export type { Task, TaskStatus } from "./services/TaskManager.js";
// Phase 1 services (v3.0 superpower tools)
export { TaskManager } from "./services/TaskManager.js";
export type { AgentMessage, Team } from "./services/TeamManager.js";
export { TeamManager } from "./services/TeamManager.js";
export type { Worktree } from "./services/WorktreeManager.js";
export { WorktreeManager } from "./services/WorktreeManager.js";
// Transform API
export { BashTransformPipeline } from "./transform/pipeline.js";
export type { CommandCollectorMetadata } from "./transform/plugins/command-collector.js";
export { CommandCollectorPlugin } from "./transform/plugins/command-collector.js";
export type {
  TeeFileInfo,
  TeePluginMetadata,
  TeePluginOptions,
} from "./transform/plugins/tee-plugin.js";
export { TeePlugin } from "./transform/plugins/tee-plugin.js";
export { serialize } from "./transform/serialize.js";
export type {
  BashTransformResult,
  TransformContext,
  TransformPlugin,
  TransformResult,
} from "./transform/types.js";
export type {
  BashExecResult,
  Command,
  CommandContext,
  ExecResult,
  IFileSystem,
} from "./types.js";
