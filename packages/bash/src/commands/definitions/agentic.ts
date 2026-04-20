import type { LazyCommandDef } from "../lib.js";
import type { CommandName } from "../registry.js";

export const agenticLoaders: LazyCommandDef<CommandName>[] = [
  { name: "ag-edit" as CommandName, load: async () => (await import("../ag-edit/ag-edit.js")).agEditCommand },
  { name: "ag-diff" as CommandName, load: async () => (await import("../ag-diff/ag-diff.js")).agDiffCommand },
  { name: "ag-snapshot" as CommandName, load: async () => (await import("../ag-snapshot/ag-snapshot.js")).agSnapshotCommand },
  { name: "ag-analyze" as CommandName, load: async () => (await import("../ag-analyze/ag-analyze.js")).agAnalyzeCommand },
];
