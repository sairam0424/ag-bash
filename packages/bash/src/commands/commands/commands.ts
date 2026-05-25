import type { Command, CommandContext, ExecResult } from "../../types.js";
import { showHelp } from "../help.js";

const commandsHelp = {
  name: "commands",
  summary: "list all available ag-bash commands",
  usage: "commands [OPTIONS] [name]",
  options: [
    "--list          flat list of command names (one per line)",
    "--category CAT  filter by category (core, text, search, data, agentic, network)",
    "--search TERM   search commands by name or description",
  ],
  examples: [
    "commands                  # show all commands grouped by category",
    "commands --list           # flat list for scripting",
    "commands --search json    # find JSON-related commands",
    "commands --category data  # show data/structured commands",
    "commands echo             # show help for echo command",
  ],
};

// Static category definitions
const CATEGORIES: Record<string, { label: string; commands: string[] }> =
  Object.create(null);

// Populate categories - use Object.assign pattern to avoid prototype
Object.assign(CATEGORIES, {
  core: {
    label: "Core I/O",
    commands: [
      "echo",
      "cat",
      "ls",
      "cp",
      "mv",
      "rm",
      "mkdir",
      "rmdir",
      "touch",
      "ln",
      "stat",
      "du",
      "tree",
      "pwd",
      "cd",
      "tee",
      "printf",
      "readlink",
      "basename",
      "dirname",
      "env",
      "whoami",
      "hostname",
      "date",
      "sleep",
      "seq",
      "timeout",
      "clear",
    ],
  },
  text: {
    label: "Text Processing",
    commands: [
      "grep",
      "sed",
      "awk",
      "cut",
      "tr",
      "sort",
      "uniq",
      "wc",
      "head",
      "tail",
      "tac",
      "rev",
      "paste",
      "join",
      "comm",
      "column",
      "fold",
      "expand",
      "nl",
      "od",
      "strings",
      "split",
      "xargs",
    ],
  },
  search: {
    label: "Search & Find",
    commands: [
      "find",
      "rg",
      "ag-grep",
      "ag-find-files",
      "ag-find-symbol",
      "ag-references",
      "ag-hover",
    ],
  },
  data: {
    label: "Data & Structured",
    commands: [
      "jq",
      "yq",
      "xan",
      "sqlite3",
      "python3",
      "js-exec",
      "base64",
      "md5sum",
      "file",
      "diff",
    ],
  },
  agentic: {
    label: "Agentic Tools",
    commands: [
      "ag-edit",
      "ag-diff",
      "ag-analyze",
      "ag-explain",
      "ag-convert",
      "ag-snapshot",
      "ag-plan",
      "ag-task",
      "ag-todo",
      "ag-team",
      "ag-orchestration",
      "ag-mcp",
      "ag-cron",
      "ag-worktree",
      "ag-web",
      "ag-message",
      "ag-notebook",
      "ag-glob",
    ],
  },
  archive: {
    label: "Archive & Encoding",
    commands: ["tar", "gzip", "base64", "html-to-markdown"],
  },
  network: {
    label: "Network",
    commands: ["curl"],
  },
});

// One-line descriptions for common commands
const DESCRIPTIONS: Record<string, string> = Object.create(null);
Object.assign(DESCRIPTIONS, {
  echo: "display text",
  cat: "concatenate and print files",
  ls: "list directory contents",
  cp: "copy files and directories",
  mv: "move/rename files",
  rm: "remove files or directories",
  mkdir: "create directories",
  touch: "create empty files or update timestamps",
  grep: "search text with patterns",
  sed: "stream editor for text transformation",
  awk: "pattern scanning and processing",
  find: "search for files in directory tree",
  rg: "ripgrep — fast recursive search",
  jq: "JSON processor",
  yq: "YAML/TOML/XML processor",
  curl: "transfer data via HTTP",
  sort: "sort lines of text",
  wc: "count lines, words, and bytes",
  head: "output first lines of files",
  tail: "output last lines of files",
  cut: "extract columns from text",
  tr: "translate or delete characters",
  uniq: "filter duplicate lines",
  xargs: "build and execute commands from stdin",
  tee: "read stdin and write to files and stdout",
  diff: "compare files line by line",
  tar: "archive files",
  tree: "display directory tree",
  stat: "display file status",
  du: "estimate file space usage",
  "ag-edit": "surgical line-based file editing",
  "ag-diff": "semantic code diffing",
  "ag-analyze": "code structure analysis",
  "ag-explain": "explain code or commands",
  "ag-snapshot": "state snapshotting",
  "ag-plan": "planning mode toggle",
  "ag-task": "task management",
  "ag-todo": "TODO tracking",
  "ag-team": "multi-agent collaboration",
  "ag-mcp": "MCP tool integration",
  "ag-cron": "scheduled job management",
  "ag-web": "web search and fetch",
  sqlite3: "SQLite database engine",
  python3: "Python interpreter (WASM)",
  "js-exec": "JavaScript runtime (QuickJS)",
  about: "show ag-bash features and info",
  doctor: "verify environment health",
  commands: "list all available commands",
});

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

export const commandsCommand: Command = {
  name: "commands",
  // Note: ctx.exec is the sandboxed ag-bash interpreter method, not child_process
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    if (args.includes("--help") || args.includes("-h")) {
      return showHelp(commandsHelp);
    }

    // Get all registered commands
    const registered = ctx.getRegisteredCommands
      ? ctx.getRegisteredCommands()
      : [];

    // commands <name> — show help for a specific command
    const positional = args.filter(
      (a) =>
        !a.startsWith("-") &&
        a !== args[args.indexOf("--category") + 1] &&
        a !== args[args.indexOf("--search") + 1],
    );
    if (
      positional.length > 0 &&
      !args.includes("--list") &&
      !args.includes("--category") &&
      !args.includes("--search")
    ) {
      const name = positional[0];
      if (ctx.exec) {
        const result = await ctx.exec(`${name} --help`, { cwd: ctx.cwd });
        return result;
      }
      return {
        stdout: "",
        stderr: `commands: cannot show help for '${name}'\n`,
        exitCode: 1,
      };
    }

    // --list: flat output
    if (args.includes("--list")) {
      const sorted = [...registered].sort();
      return { stdout: `${sorted.join("\n")}\n`, stderr: "", exitCode: 0 };
    }

    // --search TERM
    const searchTerm = getFlagValue(args, "--search");
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      const matches = registered
        .filter((cmd) => {
          const desc = DESCRIPTIONS[cmd] ?? "";
          return (
            cmd.toLowerCase().includes(term) ||
            desc.toLowerCase().includes(term)
          );
        })
        .sort();

      if (matches.length === 0) {
        return {
          stdout: `No commands matching '${searchTerm}'\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      let output = `Commands matching '${searchTerm}':\n\n`;
      for (const cmd of matches) {
        const desc = DESCRIPTIONS[cmd] ?? "";
        output += `  ${cmd.padEnd(20)} ${desc}\n`;
      }
      return { stdout: output, stderr: "", exitCode: 0 };
    }

    // --category CAT
    const categoryFilter = getFlagValue(args, "--category");
    if (categoryFilter) {
      const cat = CATEGORIES[categoryFilter.toLowerCase()];
      if (!cat) {
        const available = Object.keys(CATEGORIES).join(", ");
        return {
          stdout: "",
          stderr: `commands: unknown category '${categoryFilter}'. Available: ${available}\n`,
          exitCode: 1,
        };
      }
      const available = cat.commands.filter((c) => registered.includes(c));
      let output = `${cat.label} (${available.length} commands):\n\n`;
      for (const cmd of available) {
        const desc = DESCRIPTIONS[cmd] ?? "";
        output += `  ${cmd.padEnd(20)} ${desc}\n`;
      }
      return { stdout: output, stderr: "", exitCode: 0 };
    }

    // Default: show all commands grouped by category
    let output = `ag-bash commands (${registered.length} total):\n\n`;

    for (const [, cat] of Object.entries(CATEGORIES)) {
      const available = cat.commands.filter((c) => registered.includes(c));
      if (available.length === 0) continue;
      output += `${cat.label}:\n`;
      for (const cmd of available) {
        const desc = DESCRIPTIONS[cmd] ?? "";
        output += `  ${cmd.padEnd(20)} ${desc}\n`;
      }
      output += "\n";
    }

    // Show uncategorized commands
    const categorized = new Set(
      Object.values(CATEGORIES).flatMap((c) => c.commands),
    );
    const uncategorized = registered.filter((c) => !categorized.has(c)).sort();
    if (uncategorized.length > 0) {
      output += `Other (${uncategorized.length}):\n`;
      for (const cmd of uncategorized) {
        output += `  ${cmd}\n`;
      }
      output += "\n";
    }

    output += `Use 'commands <name>' for help on a specific command.\n`;
    output += `Use 'commands --search <term>' to search.\n`;

    return { stdout: output, stderr: "", exitCode: 0 };
  },
};
