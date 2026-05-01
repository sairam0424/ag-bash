/**
 * State-Sync - Context-Diff Bridge
 *
 * Provides utilities for generating and applying deltas between
 * Bash snapshots. This is used for efficient synchronization
 * of agentic workspaces.
 */

import type { BashSnapshot } from "../Bash.js";
import type { InterpreterState } from "../interpreter/types.js";

export interface BashDelta {
  /** Map of changed environment variables. Null indicates deletion. */
  envDelta?: Record<string, string | null>;
  /** Map of changed functions. Null indicates deletion. */
  funcDelta?: Record<string, string | null>;
  /** Filesystem changes. */
  fsDelta?: FsDelta;
  /** Metadata like CWD. */
  cwd?: string;
}

export interface FsDelta {
  /** New or modified files: path -> content (string or base64) */
  modified: Record<string, string | Uint8Array>;
  /** Deleted absolute paths */
  deleted: string[];
}

/**
 * Generates a delta between a base snapshot and current state.
 */
export function diffState(
  base: BashSnapshot,
  current: BashSnapshot,
): BashDelta {
  const delta: BashDelta = {};

  // 1. Diff Environment Variables (Map<string, string>)
  const envDelta: Record<string, string | null> = {};
  let envChanged = false;

  const baseEnv = base.state.env;
  const currEnv = current.state.env;

  // Added or modified
  for (const [key, val] of currEnv.entries()) {
    if (baseEnv.get(key) !== val) {
      envDelta[key] = val;
      envChanged = true;
    }
  }

  // Deleted
  for (const key of baseEnv.keys()) {
    if (!currEnv.has(key)) {
      envDelta[key] = null;
      envChanged = true;
    }
  }

  if (envChanged) delta.envDelta = envDelta;

  // 2. Diff Functions (Map<string, FunctionDefNode>)
  const funcDelta: Record<string, string | null> = {};
  let funcChanged = false;

  const baseFuncs = base.state.functions;
  const currFuncs = current.state.functions;

  for (const [name, node] of currFuncs.entries()) {
    const baseNode = baseFuncs.get(name);
    if (baseNode !== node) {
      funcDelta[name] = "MODIFIED";
      funcChanged = true;
    }
  }

  for (const name of baseFuncs.keys()) {
    if (!currFuncs.has(name)) {
      funcDelta[name] = null;
      funcChanged = true;
    }
  }

  if (funcChanged) delta.funcDelta = funcDelta;

  // 3. Diff CWD
  if (base.state.cwd !== current.state.cwd) {
    delta.cwd = current.state.cwd;
  }

  return delta;
}

/**
 * Diffs two VFS snapshots. Handles both raw Maps and MountableFs snapshot objects.
 */
export function diffFs(baseFs: any, currentFs: any): FsDelta {
  const modified: Record<string, string | Uint8Array> = {};
  const deleted: string[] = [];

  // Unwrap MountableFs snapshots if necessary
  const bMap = baseFs && baseFs.base instanceof Map ? baseFs.base : baseFs;
  const cMap =
    currentFs && currentFs.base instanceof Map ? currentFs.base : currentFs;

  if (cMap instanceof Map && bMap instanceof Map) {
    for (const [path, entry] of cMap.entries()) {
      const baseEntry = bMap.get(path);
      if (!baseEntry) {
        // New entry
        if (entry.type === "file" && "content" in entry) {
          modified[path] = entry.content;
        }
      } else if (entry.type === "file" && "content" in entry) {
        // Check for content change
        if (entry.content !== baseEntry.content) {
          modified[path] = entry.content;
        }
      }
    }

    for (const path of bMap.keys()) {
      if (!cMap.has(path)) {
        deleted.push(path);
      }
    }
  }

  return { modified, deleted };
}

/**
 * Applies a delta to an interpreter state.
 */
export function applyStateDelta(
  state: InterpreterState,
  delta: BashDelta,
): void {
  // 1. Apply Env
  if (delta.envDelta) {
    for (const [key, val] of Object.entries(delta.envDelta)) {
      if (val === null) {
        state.env.delete(key);
      } else {
        state.env.set(key, val);
      }
    }
  }

  // 2. Apply Functions
  if (delta.funcDelta) {
    for (const [name, body] of Object.entries(delta.funcDelta)) {
      if (body === null) {
        state.functions.delete(name);
      } else {
        // Placeholder
      }
    }
  }

  // 3. Apply CWD
  if (delta.cwd) {
    state.cwd = delta.cwd;
  }
}
