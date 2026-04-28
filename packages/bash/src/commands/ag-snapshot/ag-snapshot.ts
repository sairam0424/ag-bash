import type { Command, CommandContext, ExecResult } from "../../types.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agSnapshotHelp = {
  name: "ag-snapshot",
  summary: "manage filesystem snapshots for state persistence and rollbacks",
  usage: "ag-snapshot [create|restore|list|delete] [SNAPSHOT_ID]",
  options: ["    --help        display this help and exit"],
};

// Global map to store snapshots for the current session
// In a real implementation, this might persist to some storage.
const _snapshots = new Map<string, any>();

export const agSnapshotCommand: Command = {
  name: "ag-snapshot",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(agSnapshotHelp);

    const positional = args.filter((a) => !a.startsWith("-"));
    const action = positional[0] || "list";
    const id = positional[1];

    const SNAPSHOT_DIR = ctx.fs.resolvePath(ctx.cwd, ".ag-snapshots");
    const ictx = ctx as any;

    async function ensureSnapshotDir() {
      if (!(await ctx.fs.exists(SNAPSHOT_DIR))) {
        await ctx.fs.mkdir(SNAPSHOT_DIR, { recursive: true });
      }
    }

    switch (action) {
      case "create": {
        const snapshotId = id || `snap_${Date.now()}`;
        try {
          await ensureSnapshotDir();
          const snapshotPath = ctx.fs.resolvePath(
            SNAPSHOT_DIR,
            `${snapshotId}.json`,
          );

          let fsSnapshot = await ctx.fs.snapshot?.();
          // If it's a Map (from InMemoryFs), convert to entries for JSON
          if (fsSnapshot instanceof Map) {
            fsSnapshot = Array.from(fsSnapshot.entries());
          }

          const snapshotData = {
            id: snapshotId,
            timestamp: Date.now(),
            cwd: ctx.cwd,
            env: Object.assign(
              Object.create(null),
              Object.fromEntries(ictx.state.env),
            ),
            functions: Object.assign(
              Object.create(null),
              Object.fromEntries(
                Array.from(
                  ictx.state.functions.entries() as [string, any][],
                ).map(([name, node]) => [name, node]),
              ),
            ),
            fs: fsSnapshot,
          };

          await ctx.fs.writeFile(
            snapshotPath,
            JSON.stringify(snapshotData, null, 2),
          );

          return {
            stdout: `Snapshot '${snapshotId}' created successfully.\n`,
            stderr: "",
            exitCode: 0,
          };
        } catch (e: any) {
          return {
            stdout: "",
            stderr: `ag-snapshot: failed to create: ${e.message}\n`,
            exitCode: 1,
          };
        }
      }

      case "restore": {
        if (!id)
          return {
            stdout: "",
            stderr: "ag-snapshot: missing snapshot ID\n",
            exitCode: 1,
          };
        const snapshotPath = ctx.fs.resolvePath(SNAPSHOT_DIR, `${id}.json`);

        if (!(await ctx.fs.exists(snapshotPath))) {
          return {
            stdout: "",
            stderr: `ag-snapshot: snapshot '${id}' not found\n`,
            exitCode: 1,
          };
        }

        try {
          const raw = await ctx.fs.readFile(snapshotPath, "utf8");
          const data = JSON.parse(raw);

          // Restore environment
          ictx.state.env = new Map(Object.entries(data.env));
          ictx.state.functions = new Map(Object.entries(data.functions));

          // Restore FS
          if (data.fs && ctx.fs.restore) {
            let fsToRestore = data.fs;
            if (Array.isArray(fsToRestore)) {
              fsToRestore = new Map(fsToRestore);
            }
            await ctx.fs.restore(fsToRestore);
          }

          return {
            stdout: `Restored session and environment from snapshot '${id}'.\n`,
            stderr: "",
            exitCode: 0,
          };
        } catch (e: any) {
          return {
            stdout: "",
            stderr: `ag-snapshot: failed to restore: ${e.message}\n`,
            exitCode: 1,
          };
        }
      }

      case "list": {
        try {
          if (!(await ctx.fs.exists(SNAPSHOT_DIR))) {
            return { stdout: "No snapshots found.\n", stderr: "", exitCode: 0 };
          }
          const files = await ctx.fs.readdir(SNAPSHOT_DIR);
          const snaps = files
            .filter((f) => f.endsWith(".json"))
            .map((f) => f.replace(".json", ""))
            .join("\n");

          return {
            stdout: snaps ? `${snaps}\n` : "No snapshots found.\n",
            stderr: "",
            exitCode: 0,
          };
        } catch (e: any) {
          return {
            stdout: "",
            stderr: `ag-snapshot: failed to list: ${e.message}\n`,
            exitCode: 1,
          };
        }
      }

      case "delete": {
        if (!id)
          return {
            stdout: "",
            stderr: "ag-snapshot: missing snapshot ID\n",
            exitCode: 1,
          };
        const snapshotPath = ctx.fs.resolvePath(SNAPSHOT_DIR, `${id}.json`);

        try {
          if (!(await ctx.fs.exists(snapshotPath))) {
            return {
              stdout: "",
              stderr: `ag-snapshot: snapshot '${id}' not found\n`,
              exitCode: 1,
            };
          }
          await ctx.fs.rm(snapshotPath);
          return {
            stdout: `Deleted snapshot '${id}'.\n`,
            stderr: "",
            exitCode: 0,
          };
        } catch (e: any) {
          return {
            stdout: "",
            stderr: `ag-snapshot: failed to delete: ${e.message}\n`,
            exitCode: 1,
          };
        }
      }

      default:
        return {
          stdout: "",
          stderr: `ag-snapshot: unknown action: ${action}\n`,
          exitCode: 1,
        };
    }
  },
};
