import type { LazyCommandDef } from "../lib.js";
import type { CommandName } from "../registry.js";

export const agenticLoaders: LazyCommandDef<CommandName>[] = [
  { name: "ag-edit" as CommandName, load: async () => (await import("../ag-edit/ag-edit.js")).agEditCommand },
  { name: "ag-diff" as CommandName, load: async () => (await import("../ag-diff/ag-diff.js")).agDiffCommand },
  { name: "ag-snapshot" as CommandName, load: async () => (await import("../ag-snapshot/ag-snapshot.js")).agSnapshotCommand },
  { name: "ag-analyze" as CommandName, load: async () => (await import("../ag-analyze/ag-analyze.js")).agAnalyzeCommand },
  { name: "ag-find-symbol" as CommandName, load: async () => (await import("../ag-find-symbol/ag-find-symbol.js")).agFindSymbolCommand },
  { name: "ag-references" as CommandName, load: async () => (await import("../ag-references/ag-references.js")).agReferencesCommand },
  { name: "ag-mcp" as CommandName, load: async () => (await import("../ag-mcp/ag-mcp.js")).agMcp },
  { name: "ag-spawn" as CommandName, load: async () => (await import("../ag-orchestration/ag-spawn.js")).agSpawn },
  { name: "ag-wait" as CommandName, load: async () => (await import("../ag-orchestration/ag-wait.js")).agWait },
  { name: "ag-list-agents" as CommandName, load: async () => (await import("../ag-orchestration/ag-list-agents.js")).agListAgents },
  { name: "ag-hover" as CommandName, load: async () => (await import("../ag-hover/ag-hover.js")).agHoverCommand },
  { name: "ag-explain" as CommandName, load: async () => (await import("../ag-explain/ag-explain.js")).agExplainCommand },
  { name: "ag-todo" as CommandName, load: async () => (await import("../ag-todo/ag-todo.js")).agTodoCommand },
];
