import type { Command, CommandContext, ExecResult } from "../../types.js";
import { VERSION } from "../../version.js";
import { showHelp } from "../help.js";

const aboutHelp = {
  name: "about",
  summary: "show ag-bash features, architecture, and quick-start guide",
  usage: "about [OPTIONS]",
  options: [
    "--version        print version only",
    "--features       list all features with status",
    "--architecture   show architecture diagram",
  ],
};

const FEATURES = [
  "113+ Commands (Core I/O, Text, Data, Search, Agentic, Network)",
  "Multi-Runtime (Bash + Python3 WASM + JavaScript QuickJS)",
  "Agent RunLoop (autonomous LLM execution with budget control)",
  "Tagged Template API (createShell with injection-safe escaping)",
  "Self-Healing (typo correction with exponential backoff retry)",
  "MCP Server (40+ tools exposed via Model Context Protocol)",
  "OpenTelemetry (optional zero-overhead distributed tracing)",
  "Trap Handlers (EXIT/ERR/DEBUG/RETURN fire correctly)",
  "Streaming Execution (AsyncGenerator output chunks)",
  "Copy-on-Write Filesystem (multi-agent isolation)",
  "Observation Summarizer (structured turn context for LLMs)",
  "Multi-Framework AI Adapters (Vercel/OpenAI/Anthropic/LangChain)",
  "Defense-in-Depth Security (sandboxed, no real OS access)",
  "Tiered Exports (slim, advanced, browser-core, testing, ai, agent-runtime)",
];

const ARCHITECTURE = `  Input Script
    |
    v
  Parser (Tree-sitter + Recursive Descent)
    |
    v
  AST (Abstract Syntax Tree with ASTCache)
    |
    v
  Interpreter (Expansion -> Resolution -> Execution)
    |
    v
  ExecResult { stdout, stderr, exitCode }

  Filesystem: Pluggable VFS (InMemory | Overlay | ReadWrite | CowFs)
  Security:   Defense-in-Depth + AsyncLocalStorage scoping
  Runtimes:   Bash + CPython (WASM) + QuickJS (WASM)`;

export const aboutCommand: Command = {
  name: "about",
  execute: async (
    args: string[],
    _ctx: CommandContext,
  ): Promise<ExecResult> => {
    if (args.includes("--help") || args.includes("-h")) {
      return showHelp(aboutHelp);
    }

    if (args.includes("--version") || args.includes("-v")) {
      return { stdout: `${VERSION}\n`, stderr: "", exitCode: 0 };
    }

    if (args.includes("--features")) {
      let output = `ag-bash v${VERSION} — Features:\n\n`;
      for (const feature of FEATURES) {
        output += `  * ${feature}\n`;
      }
      return { stdout: output, stderr: "", exitCode: 0 };
    }

    if (args.includes("--architecture")) {
      let output = `ag-bash v${VERSION} — Architecture:\n\n`;
      output += `${ARCHITECTURE}\n`;
      return { stdout: output, stderr: "", exitCode: 0 };
    }

    // Default: full overview
    let output = "";
    output += `ag-bash v${VERSION} — AI-Native Sandboxed Bash Runtime\n`;
    output += `${"=".repeat(52)}\n\n`;

    output += `ARCHITECTURE\n`;
    output += `  Input -> Parser (Tree-sitter) -> AST -> Interpreter -> ExecResult\n`;
    output += `  Filesystem: Pluggable VFS (InMemory | Overlay | ReadWrite)\n`;
    output += `  Security: Defense-in-Depth + Sandboxed Execution\n\n`;

    output += `FEATURES\n`;
    for (const feature of FEATURES) {
      output += `  * ${feature}\n`;
    }
    output += `\n`;

    output += `QUICK START\n`;
    output += `  Run: commands              - Browse all available commands\n`;
    output += `  Run: doctor                - Verify your environment\n`;
    output += `  Run: help <builtin>        - Shell builtin help\n`;
    output += `  Run: <command> --help      - Command-specific help\n\n`;

    output += `LINKS\n`;
    output += `  GitHub: https://github.com/sairam0424/ag-bash\n`;
    output += `  Docs:   See docs/user-guide.md\n`;

    return { stdout: output, stderr: "", exitCode: 0 };
  },
};
