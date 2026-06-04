/**
 * AgentMemorySync - Cross-session persistence for the AgentMemory service.
 *
 * Provides functions to load and save agent memory to/from the virtual
 * filesystem, enabling memory to survive across shell sessions.
 *
 * File layout:
 *   /.ag-bash/agent-memory/<scope>/<agentType>.json
 *
 * Each JSON file contains an array of MemoryEntry objects for that
 * agent+scope combination.
 */

import type { AgentMemory, MemoryEntry, MemoryScope } from "./AgentMemory.js";

// ---------------------------------------------------------------------------
// Filesystem interface - matches the ag-bash VFS API
// ---------------------------------------------------------------------------

export interface SyncFs {
  exists(path: string): Promise<boolean>;
  // `encoding` is narrowed to the literal `"utf-8"` (the only value this
  // module ever passes) so that the ag-bash VFS implementations — whose
  // `readFile` accepts `ReadFileOptions | BufferEncoding` (a domain-local
  // `BufferEncoding` that excludes e.g. "utf16le") — remain structurally
  // assignable to `SyncFs` without coupling this file to the fs interface.
  readFile(path: string, encoding?: "utf-8"): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMORY_BASE = "/.ag-bash/agent-memory";

const ALL_SCOPES: readonly MemoryScope[] = ["user", "project", "local"];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize an agentType string so it is safe to use as a filename.
 * Replaces `:` and `/` (and `\` for completeness) with `-`, then
 * collapses consecutive dashes and trims leading/trailing dashes.
 */
function sanitizeAgentType(agentType: string): string {
  return agentType
    .replace(/[:/\\]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Build the filesystem path for a given scope + agentType. */
function entryPath(scope: MemoryScope, agentType: string): string {
  return `${MEMORY_BASE}/${scope}/${sanitizeAgentType(agentType)}.json`;
}

/** Build the directory path for a given scope. */
function scopeDir(scope: MemoryScope): string {
  return `${MEMORY_BASE}/${scope}`;
}

/**
 * Safely read and parse a JSON file. Returns an empty array if the file
 * does not exist or contains invalid JSON.
 */
async function readEntries(fs: SyncFs, path: string): Promise<MemoryEntry[]> {
  try {
    const fileExists = await fs.exists(path);
    if (!fileExists) {
      return [];
    }
    const raw = await fs.readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as MemoryEntry[];
  } catch {
    // Corrupt file, missing file, permission error - degrade gracefully.
    return [];
  }
}

/**
 * Ensure the directory for a scope exists, creating it recursively if
 * necessary.
 */
async function ensureScopeDir(fs: SyncFs, scope: MemoryScope): Promise<void> {
  const dir = scopeDir(scope);
  const dirExists = await fs.exists(dir);
  if (!dirExists) {
    await fs.mkdir(dir, { recursive: true });
  }
}

/**
 * Group an array of MemoryEntry objects by a composite key of
 * `scope + agentType`.
 */
function groupEntries(entries: MemoryEntry[]): Map<string, MemoryEntry[]> {
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const key = `${entry.scope}:${entry.agentType}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(entry);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load persisted agent memories from the VFS into the AgentMemory instance.
 *
 * Reads from `/.ag-bash/agent-memory/<scope>/<agentType>.json` for every
 * agent type found on disk within the requested scopes. Entries are merged
 * with whatever is already in memory: when a key collision occurs the entry
 * with the more recent `updatedAt` timestamp wins.
 *
 * @param memory  The AgentMemory instance to hydrate.
 * @param fs      A VFS implementation satisfying `SyncFs`.
 * @param scopes  Which scopes to load (default: all three).
 * @returns       The total number of entries loaded (merged) from disk.
 */
export async function loadMemoryFromFs(
  memory: AgentMemory,
  fs: SyncFs,
  scopes?: MemoryScope[],
): Promise<number> {
  const targetScopes = scopes ?? [...ALL_SCOPES];
  let loadedCount = 0;

  for (const scope of targetScopes) {
    const dir = scopeDir(scope);
    const dirExists = await fs.exists(dir);
    if (!dirExists) {
      continue;
    }

    // Discover agent-type files by checking known agent types already in
    // memory and by scanning the scope directory.  Because SyncFs does not
    // expose a readdir, we rely on a two-pass strategy:
    //
    // 1. Try to load files for every agent type already known in memory.
    // 2. Additionally, read a manifest file that lists all persisted agent
    //    types for this scope (written during save).

    const knownTypes = new Set<string>(memory.listAllAgentTypes());

    // Attempt to read the manifest.
    const manifestPath = `${dir}/.manifest.json`;
    try {
      const manifestExists = await fs.exists(manifestPath);
      if (manifestExists) {
        const raw = await fs.readFile(manifestPath, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const t of parsed) {
            if (typeof t === "string") {
              knownTypes.add(t);
            }
          }
        }
      }
    } catch {
      // Manifest is optional - proceed without it.
    }

    for (const agentType of knownTypes) {
      const path = entryPath(scope, agentType);
      const diskEntries = await readEntries(fs, path);

      for (const diskEntry of diskEntries) {
        const existing = memory.read(
          diskEntry.agentType,
          diskEntry.scope,
          diskEntry.key,
        );

        // Merge strategy: newer updatedAt wins. If no existing entry, load
        // unconditionally.
        if (!existing || diskEntry.updatedAt > existing.updatedAt) {
          memory.write(
            diskEntry.agentType,
            diskEntry.scope,
            diskEntry.key,
            diskEntry.value,
          );

          // Patch timestamps to match the persisted values so round-tripping
          // is stable. `write()` sets updatedAt to Date.now(), so we
          // overwrite with the persisted value.  We read the entry back and
          // mutate directly (the reference is held in the internal Map).
          const written = memory.read(
            diskEntry.agentType,
            diskEntry.scope,
            diskEntry.key,
          );
          if (written) {
            written.createdAt = diskEntry.createdAt;
            written.updatedAt = diskEntry.updatedAt;
          }

          loadedCount++;
        }
      }
    }
  }

  return loadedCount;
}

/**
 * Save all agent memories to the VFS.
 *
 * Groups memories by scope and agentType, writing one JSON file per group
 * to `/.ag-bash/agent-memory/<scope>/<agentType>.json`. Also writes a
 * `.manifest.json` per scope directory so that `loadMemoryFromFs` can
 * discover agent types without requiring a `readdir` on the VFS.
 *
 * @param memory  The AgentMemory instance to persist.
 * @param fs      A VFS implementation satisfying `SyncFs`.
 * @returns       The total number of entries written to disk.
 */
export async function saveMemoryToFs(
  memory: AgentMemory,
  fs: SyncFs,
): Promise<number> {
  const allEntries = memory.toJSON();
  if (allEntries.length === 0) {
    return 0;
  }

  const groups = groupEntries(allEntries);

  // Track which agent types exist per scope for the manifest.
  const scopeAgentTypes = new Map<MemoryScope, Set<string>>();

  let savedCount = 0;

  for (const [, entries] of groups) {
    // All entries in a group share the same scope and agentType.
    // groupEntries only creates a group once it has at least one entry,
    // so entries[0] is always present here.
    const first = entries[0];
    if (!first) continue;
    const { scope, agentType } = first;

    await ensureScopeDir(fs, scope);

    const path = entryPath(scope, agentType);
    await fs.writeFile(path, JSON.stringify(entries, null, 2));
    savedCount += entries.length;

    // Record the agent type for this scope.
    let typeSet = scopeAgentTypes.get(scope);
    if (!typeSet) {
      typeSet = new Set();
      scopeAgentTypes.set(scope, typeSet);
    }
    typeSet.add(agentType);
  }

  // Write manifests.
  for (const [scope, typeSet] of scopeAgentTypes) {
    const manifestPath = `${scopeDir(scope)}/.manifest.json`;
    await fs.writeFile(manifestPath, JSON.stringify([...typeSet], null, 2));
  }

  return savedCount;
}

/**
 * Sync a specific agent type's memory for a specific scope.
 *
 * This is an incremental save: only the entries matching the given
 * agentType and scope are written. Useful after a single write operation
 * to avoid re-serializing the entire memory store.
 *
 * @param memory     The AgentMemory instance to read from.
 * @param fs         A VFS implementation satisfying `SyncFs`.
 * @param agentType  The agent type to sync.
 * @param scope      The scope to sync.
 */
export async function syncAgentMemory(
  memory: AgentMemory,
  fs: SyncFs,
  agentType: string,
  scope: MemoryScope,
): Promise<void> {
  const entries = memory.list(agentType, scope);

  await ensureScopeDir(fs, scope);

  const path = entryPath(scope, agentType);

  if (entries.length === 0) {
    // Nothing to persist - but leave any existing file in place rather
    // than deleting, since SyncFs does not guarantee an unlink method.
    // Write an empty array so a subsequent load does not resurrect stale
    // data.
    await fs.writeFile(path, JSON.stringify([], null, 2));
    return;
  }

  await fs.writeFile(path, JSON.stringify(entries, null, 2));

  // Update the manifest to include this agent type.
  const manifestPath = `${scopeDir(scope)}/.manifest.json`;
  let existingTypes: string[] = [];
  try {
    const manifestExists = await fs.exists(manifestPath);
    if (manifestExists) {
      const raw = await fs.readFile(manifestPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        existingTypes = parsed.filter(
          (t): t is string => typeof t === "string",
        );
      }
    }
  } catch {
    // Start fresh if manifest is unreadable.
  }

  if (!existingTypes.includes(agentType)) {
    existingTypes.push(agentType);
    await fs.writeFile(manifestPath, JSON.stringify(existingTypes, null, 2));
  }
}
