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
  | "dirname"
  | "basename"
  // Text Processing
  | "grep"
  | "fgrep"
  | "egrep"
  | "sed"
  | "awk"
  | "sort"
  | "uniq"
  | "cut"
  | "tr"
  | "head"
  | "tail"
  | "wc"
  // System Info
  | "whoami"
  | "hostname"
  | "env"
  | "which"
  | "date"
  | "stat"
  | "du"
  // Archiving
  | "tar"
  | "gzip"
  // Logic/Search
  | "test"
  | "["
  | "expr"
  | "seq"
  | "find"
  | "rg"
  // Shell State
  | "alias"
  | "history"
  // Structured Data
  | "jq"
  | "yq"
  // Comparison
  | "diff"
  | "comm"
  // Security/Encoding
  | "base64"
  | "md5sum"
  // Time/Execution
  | "sleep"
  | "time"
  | "timeout"
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
const commandLoaders: LazyCommandDef<AllCommandName>[] = [
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
  {
    name: "dirname",
    load: async () => (await import("./dirname/dirname.js")).dirnameCommand,
  },
  {
    name: "basename",
    load: async () => (await import("./basename/basename.js")).basenameCommand,
  },

  // Text Processing
  {
    name: "grep",
    load: async () => (await import("./grep/grep.js")).grepCommand,
  },
  {
    name: "fgrep",
    load: async () => (await import("./grep/grep.js")).fgrepCommand,
  },
  {
    name: "egrep",
    load: async () => (await import("./grep/grep.js")).egrepCommand,
  },
  {
    name: "sed",
    load: async () => (await import("./sed/sed.js")).sedCommand,
  },
  {
    name: "awk",
    load: async () => (await import("./awk/awk2.js")).awkCommand2,
  },
  {
    name: "sort",
    load: async () => (await import("./sort/sort.js")).sortCommand,
  },
  {
    name: "uniq",
    load: async () => (await import("./uniq/uniq.js")).uniqCommand,
  },
  {
    name: "cut",
    load: async () => (await import("./cut/cut.js")).cutCommand,
  },
  {
    name: "tr",
    load: async () => (await import("./tr/tr.js")).trCommand,
  },
  {
    name: "head",
    load: async () => (await import("./head/head.js")).headCommand,
  },
  {
    name: "tail",
    load: async () => (await import("./tail/tail.js")).tailCommand,
  },
  {
    name: "wc",
    load: async () => (await import("./wc/wc.js")).wcCommand,
  },

  // System Info
  {
    name: "whoami",
    load: async () => (await import("./whoami/whoami.js")).whoami,
  },
  {
    name: "hostname",
    load: async () => (await import("./hostname/hostname.js")).hostname,
  },
  {
    name: "env",
    load: async () => (await import("./env/env.js")).envCommand,
  },
  {
    name: "which",
    load: async () => (await import("./which/which.js")).whichCommand,
  },
  {
    name: "date",
    load: async () => (await import("./date/date.js")).dateCommand,
  },
  {
    name: "stat",
    load: async () => (await import("./stat/stat.js")).statCommand,
  },
  {
    name: "du",
    load: async () => (await import("./du/du.js")).duCommand,
  },

  // Archiving
  {
    name: "tar",
    load: async () => (await import("./tar/tar.js")).tarCommand,
  },
  {
    name: "gzip",
    load: async () => (await import("./gzip/gzip.js")).gzipCommand,
  },

  // Logic/Search
  {
    name: "test",
    load: async () => (await import("./test/test.js")).testCommand,
  },
  {
    name: "[",
    load: async () => (await import("./test/test.js")).bracketCommand,
  },
  {
    name: "expr",
    load: async () => (await import("./expr/expr.js")).exprCommand,
  },
  {
    name: "seq",
    load: async () => (await import("./seq/seq.js")).seqCommand,
  },
  {
    name: "find",
    load: async () => (await import("./find/find.js")).findCommand,
  },
  {
    name: "rg",
    load: async () => (await import("./rg/rg.js")).rgCommand,
  },

  // Network
  {
    name: "curl",
    load: async () => (await import("./curl/curl.js")).curlCommand,
  },

  // Shell State
  {
    name: "alias",
    load: async () => (await import("./alias/alias.js")).aliasCommand,
  },
  {
    name: "history",
    load: async () => (await import("./history/history.js")).historyCommand,
  },

  // Structured Data
  {
    name: "jq",
    load: async () => (await import("./jq/jq.js")).jqCommand,
  },
  {
    name: "yq",
    load: async () => (await import("./yq/yq.js")).yqCommand,
  },

  // Comparison
  {
    name: "diff",
    load: async () => (await import("./diff/diff.js")).diffCommand,
  },
  {
    name: "comm",
    load: async () => (await import("./comm/comm.js")).commCommand,
  },

  // Security/Encoding
  {
    name: "base64",
    load: async () => (await import("./base64/base64.js")).base64Command,
  },
  {
    name: "md5sum",
    load: async () => (await import("./md5sum/md5sum.js")).md5sumCommand,
  },

  // Time/Execution
  {
    name: "sleep",
    load: async () => (await import("./sleep/sleep.js")).sleepCommand,
  },
  {
    name: "time",
    load: async () => (await import("./time/time.js")).timeCommand,
  },
  {
    name: "timeout",
    load: async () => (await import("./timeout/timeout.js")).timeoutCommand,
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

  // Language Runtimes
  {
    name: "python3",
    load: async () => (await import("./python/python3.js")).python3Command,
  },
  {
    name: "python",
    load: async () => (await import("./python/python3.js")).pythonCommand,
  },
  {
    name: "js-exec",
    load: async () => (await import("./js-exec/js-exec.js")).jsExecCommand,
  },
  {
    name: "node",
    load: async () => (await import("./js-exec/js-exec.js")).nodeStubCommand,
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
  return ["curl"];
}

/**
 * Creates all lazy commands for registration
 */
export function createLazyCommands(filter?: AllCommandName[]): Command[] {
  const loaders = filter
    ? commandLoaders.filter((def) =>
        filter.includes(def.name as AllCommandName),
      )
    : commandLoaders;
  return loaders.map(createLazyCommand);
}

/**
 * Creates network commands (curl, etc.)
 */
export function createNetworkCommands(): Command[] {
  return [
    createLazyCommand({
      name: "curl",
      load: async () => (await import("./curl/curl.js")).curlCommand,
    }),
  ];
}

/**
 * Gets all python command names
 */
export function getPythonCommandNames(): string[] {
  return ["python3", "python"];
}

/**
 * Creates python commands
 */
export function createPythonCommands(): Command[] {
  const pythonDefs = commandLoaders.filter(
    (def) => def.name === "python" || def.name === "python3",
  );
  return pythonDefs.map(createLazyCommand);
}

/**
 * Gets all javascript command names
 */
export function getJavaScriptCommandNames(): string[] {
  return ["js-exec", "node"];
}

/**
 * Creates javascript commands
 */
export function createJavaScriptCommands(): Command[] {
  const jsDefs = commandLoaders.filter(
    (def) => def.name === "js-exec" || def.name === "node",
  );
  return jsDefs.map(createLazyCommand);
}

/**
 * Clears the command cache (for testing)
 */
export function clearCommandCache(): void {
  cache.clear();
}
