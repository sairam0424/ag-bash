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
  // Basic I/O
  | "echo"
  | "cat"
  | "printf"
  // File operations
  | "ls"
  | "mkdir"
  | "rmdir"
  | "touch"
  | "rm"
  | "cp"
  | "mv"
  | "ln"
  | "chmod"
  // Navigation/Path
  | "pwd"
  | "readlink"
  // Utilities
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
const commandLoaders: LazyCommandDef<string>[] = [
  // Basic I/O
  {
    name: "echo",
    load: async () => (await import("./echo/echo.js")).echoCommand,
  },
  {
    name: "cat",
    load: async () => (await import("./cat/cat.js")).catCommand,
  },
  {
    name: "printf",
    load: async () => (await import("./printf/printf.js")).printfCommand,
  },

  // File operations
  {
    name: "ls",
    load: async () => (await import("./ls/ls.js")).lsCommand,
  },
  {
    name: "mkdir",
    load: async () => (await import("./mkdir/mkdir.js")).mkdirCommand,
  },
  {
    name: "rmdir",
    load: async () => (await import("./rmdir/rmdir.js")).rmdirCommand,
  },
  {
    name: "touch",
    load: async () => (await import("./touch/touch.js")).touchCommand,
  },
  {
    name: "rm",
    load: async () => (await import("./rm/rm.js")).rmCommand,
  },
  {
    name: "cp",
    load: async () => (await import("./cp/cp.js")).cpCommand,
  },
  {
    name: "mv",
    load: async () => (await import("./mv/mv.js")).mvCommand,
  },
  {
    name: "ln",
    load: async () => (await import("./ln/ln.js")).lnCommand,
  },
  {
    name: "chmod",
    load: async () => (await import("./chmod/chmod.js")).chmodCommand,
  },

  // Navigation/Path
  {
    name: "pwd",
    load: async () => (await import("./pwd/pwd.js")).pwdCommand,
  },
  {
    name: "readlink",
    load: async () => (await import("./readlink/readlink.js")).readlinkCommand,
  },

  // Utilities
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
    ? commandLoaders.filter((def) => filter.includes(def.name as CommandName))
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
