// Command registry with statically analyzable lazy loading
// Each command has an explicit loader function for bundler compatibility (Next.js, etc.)

import { DefenseInDepthBox } from "../security/defense-in-depth-box.js";
import type { Command, CommandContext, ExecResult } from "../types.js";

type CommandLoader = () => Promise<Command>;

interface LazyCommandDef<T extends string = string> {
  name: T;
  load: CommandLoader;
}

/** All available built-in command names */
export type CommandName =
  | "echo"
  | "true"
  | "false";

/** Network command names */
export type NetworkCommandName = "curl";

/** Python command names */
export type PythonCommandName = "python3" | "python";

/** JavaScript command names */
export type JavaScriptCommandName = "js-exec" | "node";

/** All command names including network, python, and javascript commands */
export type AllCommandName =
  | CommandName
  | NetworkCommandName
  | PythonCommandName
  | JavaScriptCommandName;

// Statically analyzable loaders - each import() call is a literal string
const commandLoaders: LazyCommandDef<CommandName>[] = [
  // Basic I/O
  {
    name: "echo",
    load: async () => (await import("./echo/echo.js")).echoCommand,
  },
  {
    name: "true",
    load: async () => (await import("./true/true.js")).trueCommand,
  },
  {
    name: "false",
    load: async () => (await import("./true/true.js")).falseCommand,
  },
];

// Cache for loaded commands
const cache = new Map<string, Command>();

/**
 * Creates a lazy command that loads on first execution
 */
function createLazyCommand(def: LazyCommandDef): Command {
  return {
    name: def.name,
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      let cmd = cache.get(def.name);

      if (!cmd) {
        cmd = await DefenseInDepthBox.runTrustedAsync(() => def.load());
        cache.set(def.name, cmd);
      }

      return cmd.execute(args, ctx);
    },
  };
}

/**
 * Gets all available command names
 */
export function getCommandNames(): string[] {
  return commandLoaders.map((def) => def.name);
}

/**
 * Gets all network command names
 */
export function getNetworkCommandNames(): string[] {
  return [];
}

/**
 * Creates all lazy commands for registration
 */
export function createLazyCommands(filter?: CommandName[]): Command[] {
  const loaders = filter
    ? commandLoaders.filter((def) => filter.includes(def.name))
    : commandLoaders;
  return loaders.map(createLazyCommand);
}

/**
 * Creates network commands (curl, etc.)
 */
export function createNetworkCommands(): Command[] {
  return [];
}

/**
 * Gets all python command names
 */
export function getPythonCommandNames(): string[] {
  return [];
}

/**
 * Creates python commands
 */
export function createPythonCommands(): Command[] {
  return [];
}

/**
 * Gets all javascript command names
 */
export function getJavaScriptCommandNames(): string[] {
  return [];
}

/**
 * Creates javascript commands
 */
export function createJavaScriptCommands(): Command[] {
  return [];
}

/**
 * Clears the command cache (for testing)
 */
export function clearCommandCache(): void {
  cache.clear();
}
