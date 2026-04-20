import type { LazyCommandDef } from "../lib.js";
import type { CommandName } from "../registry.js";

export const coreLoaders: LazyCommandDef<CommandName>[] = [
  // Basic I/O
  { name: "echo" as CommandName, load: async () => (await import("../echo/echo.js")).echoCommand },
  { name: "cat" as CommandName, load: async () => (await import("../cat/cat.js")).catCommand },
  { name: "printf" as CommandName, load: async () => (await import("../printf/printf.js")).printfCommand },
  { name: "git" as CommandName, load: async () => (await import("../git.js")).gitCommand },

  // File operations
  { name: "ls" as CommandName, load: async () => (await import("../ls/ls.js")).lsCommand },
  { name: "mkdir" as CommandName, load: async () => (await import("../mkdir/mkdir.js")).mkdirCommand },
  { name: "rmdir" as CommandName, load: async () => (await import("../rmdir/rmdir.js")).rmdirCommand },
  { name: "touch" as CommandName, load: async () => (await import("../touch/touch.js")).touchCommand },
  { name: "rm" as CommandName, load: async () => (await import("../rm/rm.js")).rmCommand },
  { name: "cp" as CommandName, load: async () => (await import("../cp/cp.js")).cpCommand },
  { name: "mv" as CommandName, load: async () => (await import("../mv/mv.js")).mvCommand },
  { name: "ln" as CommandName, load: async () => (await import("../ln/ln.js")).lnCommand },
  { name: "chmod" as CommandName, load: async () => (await import("../chmod/chmod.js")).chmodCommand },

  // Navigation
  { name: "pwd" as CommandName, load: async () => (await import("../pwd/pwd.js")).pwdCommand },
  { name: "readlink" as CommandName, load: async () => (await import("../readlink/readlink.js")).readlinkCommand },

  // File viewing
  { name: "head" as CommandName, load: async () => (await import("../head/head.js")).headCommand },
  { name: "tail" as CommandName, load: async () => (await import("../tail/tail.js")).tailCommand },
  { name: "wc" as CommandName, load: async () => (await import("../wc/wc.js")).wcCommand },
  { name: "stat" as CommandName, load: async () => (await import("../stat/stat.js")).statCommand },

  // Search
  { name: "find" as CommandName, load: async () => (await import("../find/find.js")).findCommand },

  // Path utilities
  { name: "basename" as CommandName, load: async () => (await import("../basename/basename.js")).basenameCommand },
  { name: "dirname" as CommandName, load: async () => (await import("../dirname/dirname.js")).dirnameCommand },

  // Directory utilities
  { name: "tree" as CommandName, load: async () => (await import("../tree/tree.js")).treeCommand },
  { name: "du" as CommandName, load: async () => (await import("../du/du.js")).duCommand },

  // Environment
  { name: "env" as CommandName, load: async () => (await import("../env/env.js")).envCommand },
  { name: "printenv" as CommandName, load: async () => (await import("../env/env.js")).printenvCommand },
  { name: "alias" as CommandName, load: async () => (await import("../alias/alias.js")).aliasCommand },
  { name: "unalias" as CommandName, load: async () => (await import("../alias/alias.js")).unaliasCommand },
  { name: "history" as CommandName, load: async () => (await import("../history/history.js")).historyCommand },
  
  // Utilities
  { name: "xargs" as CommandName, load: async () => (await import("../xargs/xargs.js")).xargsCommand },
  { name: "true" as CommandName, load: async () => (await import("../true/true.js")).trueCommand },
  { name: "false" as CommandName, load: async () => (await import("../true/true.js")).falseCommand },
  { name: "clear" as CommandName, load: async () => (await import("../clear/clear.js")).clearCommand },
  { name: "bash" as CommandName, load: async () => (await import("../bash/bash.js")).bashCommand },
  { name: "sh" as CommandName, load: async () => (await import("../bash/bash.js")).shCommand },
  { name: "help" as CommandName, load: async () => (await import("../help/help.js")).helpCommand },
  { name: "which" as CommandName, load: async () => (await import("../which/which.js")).whichCommand },
  { name: "whoami" as CommandName, load: async () => (await import("../whoami/whoami.js")).whoami },
  { name: "hostname" as CommandName, load: async () => (await import("../hostname/hostname.js")).hostname },
  { name: "hello" as CommandName, load: async () => (await import("../hello/hello.js")).helloCommand },
];

// OS-native commands (suspended in browser)
declare const __BROWSER__: boolean | undefined;
const isBrowser = typeof __BROWSER__ !== "undefined" && __BROWSER__;

if (!isBrowser) {
  coreLoaders.push({
    name: "tar" as CommandName,
    load: async () => (await import("../tar/tar.js")).tarCommand,
  });
  coreLoaders.push({
    name: "yq" as CommandName,
    load: async () => (await import("../yq/yq.js")).yqCommand,
  });
  coreLoaders.push({
    name: "xan" as CommandName,
    load: async () => (await import("../xan/xan.js")).xanCommand,
  });
  coreLoaders.push({
    name: "sqlite3" as CommandName,
    load: async () => (await import("../sqlite3/sqlite3.js")).sqlite3Command,
  });
}
