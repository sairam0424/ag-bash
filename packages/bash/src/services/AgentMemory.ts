/**
 * AgentMemory - Persistent per-agent-type memory storage.
 *
 * Stores key-value memories scoped by agent type and scope level.
 * Memories persist on the virtual filesystem.
 */

export type MemoryScope = "user" | "project" | "local";

export interface MemoryEntry {
  key: string;
  value: string;
  scope: MemoryScope;
  agentType: string;
  createdAt: number;
  updatedAt: number;
}

export class AgentMemory {
  private memories: Map<string, MemoryEntry> = new Map();
  private maxEntries: number;

  constructor(options?: { maxEntries?: number }) {
    this.maxEntries = options?.maxEntries ?? 10000;
  }

  private entryKey(agentType: string, scope: MemoryScope, key: string): string {
    return `${scope}:${agentType}:${key}`;
  }

  write(
    agentType: string,
    scope: MemoryScope,
    key: string,
    value: string,
  ): MemoryEntry {
    const entryId = this.entryKey(agentType, scope, key);
    const existing = this.memories.get(entryId);
    const now = Date.now();

    const entry: MemoryEntry = {
      key,
      value,
      scope,
      agentType,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // Evict oldest entries if at capacity (skip if this is an update)
    if (!existing && this.memories.size >= this.maxEntries) {
      const oldest = this.memories.keys().next().value;
      if (oldest !== undefined) this.memories.delete(oldest);
    }

    this.memories.set(entryId, entry);
    return entry;
  }

  read(
    agentType: string,
    scope: MemoryScope,
    key: string,
  ): MemoryEntry | undefined {
    return this.memories.get(this.entryKey(agentType, scope, key));
  }

  list(agentType: string, scope?: MemoryScope): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    for (const entry of this.memories.values()) {
      if (entry.agentType !== agentType) continue;
      if (scope && entry.scope !== scope) continue;
      entries.push(entry);
    }
    return entries;
  }

  delete(agentType: string, scope: MemoryScope, key: string): boolean {
    return this.memories.delete(this.entryKey(agentType, scope, key));
  }

  listAllAgentTypes(): string[] {
    const types = new Set<string>();
    for (const entry of this.memories.values()) {
      types.add(entry.agentType);
    }
    return Array.from(types);
  }

  toJSON(): MemoryEntry[] {
    return Array.from(this.memories.values());
  }

  loadFromJSON(entries: MemoryEntry[]): void {
    this.memories.clear();
    for (const entry of entries) {
      const entryId = this.entryKey(entry.agentType, entry.scope, entry.key);
      this.memories.set(entryId, entry);
    }
  }
}
