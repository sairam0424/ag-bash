// Command registry with modular category definitions
import type { Command } from "../types.js";
import { createLazyCommand, clearCommandCache, getLoadedCommandCount } from "./lib.js";
import { coreLoaders } from "./definitions/core.js";
import { textLoaders } from "./definitions/text.js";
import { agenticLoaders } from "./definitions/agentic.js";
import { runtimeLoaders, networkLoaders } from "./definitions/runtimes.js";

/** All available built-in command names */
export type CommandName =
  | "echo" | "cat" | "printf" | "ls" | "mkdir" | "rmdir" | "touch" | "rm" | "cp" | "mv" | "ln" | "chmod"
  | "pwd" | "readlink" | "head" | "tail" | "wc" | "stat" | "grep" | "fgrep" | "egrep" | "rg" | "sed" | "awk"
  | "sort" | "uniq" | "comm" | "cut" | "paste" | "tr" | "rev" | "nl" | "fold" | "expand" | "unexpand"
  | "strings" | "split" | "column" | "join" | "tee" | "find" | "basename" | "dirname" | "tree" | "du"
  | "env" | "printenv" | "alias" | "unalias" | "history" | "xargs" | "true" | "false" | "clear" | "bash"
  | "sh" | "jq" | "base64" | "diff" | "date" | "sleep" | "timeout" | "seq" | "expr" | "md5sum" | "sha1sum"
  | "sha256sum" | "file" | "html-to-markdown" | "help" | "which" | "tac" | "hostname" | "od" | "gzip"
  | "gunzip" | "zcat" | "tar" | "yq" | "xan" | "sqlite3" | "time" | "hello" | "whoami" | "git"
  | "ag-edit" | "ag-diff" | "ag-snapshot" | "ag-analyze";

export type NetworkCommandName = "curl";
export type PythonCommandName = "python3" | "python";
export type JavaScriptCommandName = "js-exec" | "node";

export type AllCommandName =
  | CommandName
  | NetworkCommandName
  | PythonCommandName
  | JavaScriptCommandName;

// Aggregated loaders
const commandLoaders = [
  ...coreLoaders,
  ...textLoaders,
  ...agenticLoaders,
];

/**
 * Gets all available command names (excludes network commands)
 */
export function getCommandNames(): string[] {
  return commandLoaders.map((def) => def.name);
}

/**
 * Gets all network command names
 */
export function getNetworkCommandNames(): string[] {
  return networkLoaders.map((def) => def.name);
}

/**
 * Creates all lazy commands for registration
 */
export function createLazyCommands(filter?: CommandName[]): Command[] {
  const loaders = filter
    ? commandLoaders.filter((def) => filter.includes(def.name as CommandName))
    : commandLoaders;
  return loaders.map(createLazyCommand);
}

/**
 * Creates network commands for registration
 */
export function createNetworkCommands(): Command[] {
  return networkLoaders.map(createLazyCommand);
}

/**
 * Gets all python command names
 */
export function getPythonCommandNames(): string[] {
  return runtimeLoaders
    .filter(l => l.name === "python" || l.name === "python3")
    .map((def) => def.name as string);
}

/**
 * Creates python commands
 */
export function createPythonCommands(): Command[] {
  return runtimeLoaders
    .filter(l => l.name === "python" || l.name === "python3")
    .map(createLazyCommand);
}

/**
 * Gets all javascript command names
 */
export function getJavaScriptCommandNames(): string[] {
  return runtimeLoaders
    .filter(l => l.name === "js-exec" || l.name === "node")
    .map((def) => def.name as string);
}

/**
 * Creates javascript commands
 */
export function createJavaScriptCommands(): Command[] {
  return runtimeLoaders
    .filter(l => l.name === "js-exec" || l.name === "node")
    .map(createLazyCommand);
}

export { clearCommandCache, getLoadedCommandCount };
