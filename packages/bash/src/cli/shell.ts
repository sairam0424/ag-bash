/**
 * Interactive virtual shell CLI
 *
 * Usage:
 *   npx tsx src/cli/shell.ts [--cwd <dir>] [--files <json-file>]
 *
 * This provides an interactive shell experience using Bash's virtual filesystem.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Bash } from "../Bash.js";
import { OverlayFs } from "../fs/overlay-fs/overlay-fs.js";
import { getErrorMessage } from "../interpreter/helpers/errors.js";
import {
  DiscoveryService,
  type ProjectBrief,
} from "../services/DiscoveryService.js";
import { Theme } from "./theme.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the Tree-sitter `parser/vendor` directory that holds the WASM assets.
 *
 * The shell runs from two layouts with different nesting depths relative to the
 * package root, so a single hardcoded relative path cannot serve both:
 *   - src (tsx):    __dirname = src/cli       -> ../parser/vendor
 *   - dist (bundle): __dirname = dist/bin/shell -> ../../parser/vendor
 *
 * The build copies the WASM assets into `dist/parser/vendor` (see the
 * `cp src/parser/vendor/* dist/parser/vendor/` step in package.json and the
 * note in scripts/setup-vendor.js). We probe ordered candidates and return the
 * first whose `web-tree-sitter.wasm` exists, keeping resolution deterministic.
 */
function resolveVendorDir(): string {
  const candidates = [
    // dist bundle: dist/bin/shell -> dist/parser/vendor
    path.join(__dirname, "..", "..", "parser", "vendor"),
    // src via tsx: src/cli -> src/parser/vendor
    path.join(__dirname, "..", "parser", "vendor"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "web-tree-sitter.wasm"))) {
      return dir;
    }
  }
  // Fall back to the dist layout; downstream init surfaces a clear ENOENT
  // if the assets are genuinely missing.
  return candidates[0];
}

const vendorDir = resolveVendorDir();

// ANSI colors

interface ShellOptions {
  cwd?: string;
  files?: Record<string, string>;
  env?: Record<string, string>;
  network?: boolean;
  python?: boolean;
  javascript?: boolean;
}

class VirtualShell {
  private env: Bash;
  private rl: readline.Interface;
  private running = true;
  private history: string[] = [];
  private discovery: DiscoveryService;
  private projectBrief: ProjectBrief | null = null;

  private isInteractive: boolean;

  constructor(options: ShellOptions = {}) {
    // Use OverlayFs with current directory as root
    const root = process.cwd();
    const overlayFs = new OverlayFs({
      root,
      mountPoint: "/",
    });

    this.env = new Bash({
      fs: overlayFs,
      cwd: options.cwd || "/",
      env: {
        HOME: "/",
        USER: "user",
        SHELL: "/bin/bash",
        TERM: "xterm-256color",
        ...options.env,
      },
      // Network disabled by default; use --network to enable
      network:
        options.network === true
          ? { dangerouslyAllowFullInternetAccess: true }
          : undefined,
      runtimes: {
        python: options.python ?? true,
        javascript: options.javascript ?? true,
      },
      parser: {
        engine: "tree-sitter",
        treeSitterConfig: {
          webTreeSitterWasm: path.join(vendorDir, "web-tree-sitter.wasm"),
          bashGrammarWasm: path.join(vendorDir, "tree-sitter-bash.wasm"),
        },
      },
    });

    // Check if stdin is a TTY (interactive mode)
    this.isInteractive = process.stdin.isTTY === true;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: this.isInteractive,
    });

    // Handle Ctrl+C
    this.rl.on("SIGINT", () => {
      process.stdout.write("^C\n");
      this.prompt();
    });

    // Handle close (only in interactive mode)
    if (process.stdin.isTTY) {
      this.rl.on("close", () => {
        this.running = false;
        console.log("\nGoodbye!");
        process.exit(0);
      });
    }

    this.discovery = new DiscoveryService(this.env);
  }

  private syncHistory(): void {
    // Sync local history to Bash's BASH_HISTORY for the history command
    const envObj = this.env.getEnv();
    envObj.BASH_HISTORY = JSON.stringify(this.history);
  }

  private getPrompt(): string {
    const cwd = this.env.getCwd();
    const home = this.env.getEnv().HOME || "/home/user";

    // Replace home with ~
    let displayCwd = cwd;
    if (cwd === home) {
      displayCwd = "~";
    } else if (cwd.startsWith(`${home}/`)) {
      displayCwd = `~${cwd.slice(home.length)}`;
    }

    const c = Theme.colors;
    return `${c.cyan(c.bold("ag"))}${c.dim("@")}${c.bold("kernel")}${c.dim(":")}${c.bold(c.cyan(displayCwd))}${c.dim(Theme.chars.prompt)} `;
  }

  private async executeCommand(command: string): Promise<void> {
    const trimmed = command.trim();

    // Handle shell built-ins that need special treatment
    if (trimmed === "ag-info") {
      if (this.projectBrief) {
        console.log(this.discovery.getSummary(this.projectBrief));
      } else {
        console.log("No project knowledge discovered for this directory.");
      }
      return;
    }

    // Skip empty commands

    // Add to history
    this.history.push(trimmed);

    // Handle shell built-ins that need special treatment
    if (trimmed === "exit" || trimmed.startsWith("exit ")) {
      const parts = trimmed.split(/\s+/);
      const exitCode = parts[1] ? parseInt(parts[1], 10) : 0;
      console.log("exit");
      process.exit(exitCode);
    }

    // Sync local history with Bash's history for the history command
    this.syncHistory();

    // Execute command in Bash
    try {
      const result = await this.env.exec(trimmed);

      if (result.stdout) {
        process.stdout.write(result.stdout);
      }

      if (result.stderr) {
        process.stderr.write(Theme.colors.red(result.stderr));
      }
    } catch (error) {
      console.error(Theme.colors.red(`Error: ${getErrorMessage(error)}`));
    }
  }

  private printWelcome(): void {
    Theme.printHeader("1.0.0");
    Theme.printBrandManifest();

    const stats = {
      commands: 100, // Approximate
      filesystems: 2,
      python: "Enabled",
      javascript: "Enabled",
    };
    Theme.printSuccess("Node.js", "Interactive Shell", stats);
    Theme.printPowerSuite();
  }

  private prompt(): void {
    this.rl.question(this.getPrompt(), async (answer) => {
      if (!this.running) return;

      await this.executeCommand(answer);
      this.prompt();
    });
  }

  async run(): Promise<void> {
    if (this.isInteractive) {
      // Interactive mode: a TTY never bulk-drains stdin, so it is safe to scan
      // first and then start the prompt loop.
      this.projectBrief = await this.discovery.scan();

      this.printWelcome();
      if (this.projectBrief) {
        console.log(
          Theme.colors.dim(this.discovery.getSummary(this.projectBrief)) +
            Theme.colors.reset(""),
        );
      }
      this.prompt();
      return;
    }

    // Non-interactive mode: attach the `line`/`close` listeners BEFORE awaiting
    // the discovery scan. A piped (non-TTY) stream enters flowing mode as soon
    // as readline has a consumer, so any line emitted during the scan's await
    // would be lost if we registered the listener afterward (the original bug).
    // We buffer every line up front, then drain the buffer in arrival order
    // once the scan resolves, preserving command ordering.
    const lines: string[] = [];
    let inputClosed = false;

    this.rl.on("line", (line) => {
      lines.push(line);
    });

    const closePromise = new Promise<void>((resolve) => {
      this.rl.on("close", () => {
        inputClosed = true;
        resolve();
      });
    });

    // Perform initial discovery scan while stdin buffers in the background.
    this.projectBrief = await this.discovery.scan();

    // Wait for all input to be read before executing, so the full buffered
    // command list is available and ordering is deterministic.
    if (!inputClosed) {
      await closePromise;
    }

    // Execute commands sequentially in arrival order.
    for (const line of lines) {
      await this.executeCommand(line);
    }
  }
}

// CLI argument parsing
function parseArgs(): ShellOptions {
  const args = process.argv.slice(2);
  // @banned-pattern-ignore: static keys only, never accessed with user input
  const options: ShellOptions = {}; // Network disabled by default

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd" && args[i + 1]) {
      options.cwd = args[++i];
    } else if (args[i] === "--files" && args[i + 1]) {
      const filePath = args[++i];
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        options.files = JSON.parse(content);
      } catch (error) {
        console.error(`Error reading files from ${filePath}:`, error);
        process.exit(1);
      }
    } else if (args[i] === "--network") {
      options.network = true;
    } else if (args[i] === "--no-network") {
      options.network = false;
    } else if (args[i] === "--python") {
      options.python = true;
    } else if (args[i] === "--no-python") {
      options.python = false;
    } else if (args[i] === "--javascript") {
      options.javascript = true;
    } else if (args[i] === "--no-javascript") {
      options.javascript = false;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
  ag-shell — INTERACTIVE VIRTUAL BASH ENVIRONMENT
  -----------------------------------------------------------------

  Usage:
    ag-shell [options]

  Interactive shell using OverlayFS - reads from the current directory,
  writes stay in memory (copy-on-write). Perfect for safe agentic
  debugging and human-in-the-loop experimentation.

  Options:
    --cwd <path>      Initial working directory (default: /)
    --network         Enable network access (dangerouslyAllowFullInternetAccess)
    --no-network      Disable network access (default)
    --python          Enable python3 commands (default: true)
    --no-python       Disable python3 commands
    --javascript      Enable js-exec commands (default: true)
    --no-javascript   Disable js-exec commands
    -h, --help        Show this help message

  Example:
    ag-shell
    ag-shell --cwd /usr/local
    ag-shell --network
`);
      process.exit(0);
    }
  }

  return options;
}

// Main entry point
const options = parseArgs();
const shell = new VirtualShell(options);
shell.run();
