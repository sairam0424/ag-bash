/**
 * ag-bash CLI - A secure alternative to bash for AI agents
 *
 * Executes bash scripts in an isolated environment using OverlayFS.
 * Reads from the real filesystem, but writes stay in memory.
 *
 * Usage:
 *   ag-bash [options] [root-path]
 *   ag-bash -c 'script' [root-path]
 *   echo 'script' | ag-bash [root-path]
 *   ag-bash script.sh [root-path]
 *
 * Options:
 *   -c <script>       Execute the script from command line argument
 *   -e, --errexit     Exit immediately if a command exits with non-zero status
 *   --root <path>     Root directory for OverlayFS (default: current directory)
 *   --cwd <path>      Working directory within the sandbox (default: /)
 *   --json            Output results as JSON
 *   -h, --help        Show this help message
 *   -v, --version     Show version
 *
 * Arguments:
 *   script.sh         Script file to execute (reads from OverlayFS)
 *   root-path         Root directory (alternative to --root)
 *
 * Examples:
 *   # Execute inline script in current directory
 *   ag-bash -c 'ls -la'
 *
 *   # Execute script from stdin with specific root
 *   echo 'cat README.md' | ag-bash --root /path/to/project
 *
 *   # Execute script file
 *   ag-bash ./deploy.sh
 *
 *   # Execute with errexit mode
 *   ag-bash -e -c 'set -e; false; echo "not reached"'
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Bash } from "../Bash.js";
import { OverlayFs } from "../fs/overlay-fs/index.js";
import { sanitizeErrorMessage } from "../fs/real-fs-utils.js";
import { Theme } from "./theme.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CliOptions {
  script?: string;
  scriptFile?: string;
  root: string;
  cwd: string;
  cwdOverridden: boolean;
  errexit: boolean;
  allowWrite: boolean;
  python: boolean;
  javascript: boolean;
  agentic: boolean;
  plan: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
}

function printHelp(): void {
  const c = Theme.colors;
  console.log(`
  ${c.cyan(c.bold("ag-bash"))} — ${c.bold("SECURE UNIFIED AGENTIC BASH RUNTIME")}
  ${c.dim("-----------------------------------------------------------------")}

  Usage:
    ag-bash [options] [script-file]
    ag-bash -c 'script' [options]
    echo 'script' | ag-bash [options]

  Options:
    -c <script>       Execute the script from command line argument
    -e, --errexit     Exit immediately if a command exits with non-zero status
    --root <path>     Root directory for OverlayFS (default: current directory)
    --cwd <path>      Working directory within the sandbox (default: /)
    --allow-write     Allow write operations (default: read-only)
    --python          Enable python3 commands (isolated WASM)
    --javascript      Enable js-exec commands (QuickJS)
    --agentic         Enable agentic behavior and tools
    --plan            Start in plan mode (read-only for destructive tools)
    --json            Output results as JSON
    -h, --help        Show this help message
    -v, --version     Show version

  Security USPs:
    - ${c.bold("Byte-Transparent")}: 1:1 local-to-virtual mirroring via OverlayFS
    - ${c.bold("Defense-in-Depth")}: Writes stay in-memory; global sandboxing
    - ${c.bold("Cross-Runtime")}: Unified sandbox for Bash, Python, and JS
  `);

  Theme.printPowerSuite();
}

function printVersion(): void {
  console.log(
    Theme.colors.cyan(Theme.colors.bold("ag-bash")) +
      " " +
      Theme.colors.dim("v2.4.0"),
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    root: process.cwd(),
    cwd: "/",
    cwdOverridden: false,
    errexit: false,
    allowWrite: false,
    python: false,
    javascript: false,
    agentic: false,
    plan: false,
    json: false,
    help: false,
    version: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      i++;
    } else if (arg === "-v" || arg === "--version") {
      options.version = true;
      i++;
    } else if (arg === "-c") {
      if (i + 1 >= args.length) {
        console.error("Error: -c requires a script argument");
        process.exit(1);
      }
      options.script = args[i + 1];
      i += 2;
    } else if (arg === "-e" || arg === "--errexit") {
      options.errexit = true;
      i++;
    } else if (arg === "--root") {
      if (i + 1 >= args.length) {
        console.error("Error: --root requires a path argument");
        process.exit(1);
      }
      options.root = resolve(args[i + 1]);
      i += 2;
    } else if (arg === "--cwd") {
      if (i + 1 >= args.length) {
        console.error("Error: --cwd requires a path argument");
        process.exit(1);
      }
      options.cwd = args[i + 1];
      options.cwdOverridden = true;
      i += 2;
    } else if (arg === "--json") {
      options.json = true;
      i++;
    } else if (arg === "--allow-write") {
      options.allowWrite = true;
      i++;
    } else if (arg === "--python") {
      options.python = true;
      i++;
    } else if (arg === "--javascript") {
      options.javascript = true;
      i++;
    } else if (arg === "--agentic") {
      options.agentic = true;
      i++;
    } else if (arg === "--plan") {
      options.agentic = true; // --plan implies --agentic
      options.plan = true;
      i++;
    } else if (arg.startsWith("-")) {
      // Handle combined short options like -ec
      if (arg.length > 2 && !arg.startsWith("--")) {
        const flags = arg.slice(1);
        for (const flag of flags) {
          if (flag === "e") {
            options.errexit = true;
          } else if (flag === "h") {
            options.help = true;
          } else if (flag === "v") {
            options.version = true;
          } else if (flag === "c") {
            // -c must be last in combined flags
            if (i + 1 >= args.length) {
              console.error("Error: -c requires a script argument");
              process.exit(1);
            }
            options.script = args[i + 1];
            i++;
            break;
          } else {
            console.error(`Error: Unknown option: -${flag}`);
            process.exit(1);
          }
        }
        i++;
      } else {
        console.error(`Error: Unknown option: ${arg}`);
        process.exit(1);
      }
    } else {
      // Positional argument - could be script file or root path
      if (!options.scriptFile && !options.script) {
        options.scriptFile = arg;
      } else if (options.scriptFile && options.root === process.cwd()) {
        // Second positional is root
        options.root = resolve(arg);
      }
      i++;
    }
  }

  return options;
}

/**
 * Normalize a virtual path: resolve . and .., ensure starts with /
 */
function normalizePath(path: string): string {
  if (!path || path === "/") return "/";
  let normalized =
    path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  const parts = normalized.split("/").filter((p) => p && p !== ".");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return `/${resolved.join("/")}` || "/";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (options.version) {
    printVersion();
    process.exit(0);
  }

  let script: string;

  if (options.script) {
    // Script from -c argument
    script = options.script;
  } else if (options.scriptFile) {
    // Script from file - we'll read it via OverlayFS
    const fs = new OverlayFs({ root: options.root });
    const mountPoint = fs.getMountPoint();
    try {
      // Resolve script file path relative to mount point
      const virtualPath = options.scriptFile.startsWith("/")
        ? options.scriptFile
        : `${mountPoint}/${options.scriptFile}`;
      script = await fs.readFile(virtualPath, "utf-8");
    } catch (e) {
      console.error(`Error: Cannot read script file: ${options.scriptFile}`);
      console.error(
        sanitizeErrorMessage(e instanceof Error ? e.message : String(e)),
      );
      process.exit(1);
    }
  } else if (!process.stdin.isTTY) {
    // Script from stdin
    script = await readStdin();
  } else {
    // No script provided - show banner if TTY, then help
    if (process.stdin.isTTY && process.stdout.isTTY) {
      Theme.printHeader("2.4.0");
      Theme.printBrandManifest();
      Theme.printManifest({
        commands: 120,
        filesystems: 2,
        python: options.python ? "Enabled" : "Available",
        javascript: options.javascript ? "Enabled" : "Available",
        agentic: options.agentic ? "Enabled" : "Disabled",
      });
      Theme.printPowerSuite();
    }
    printHelp();
    process.exit(1);
  }

  if (!script.trim()) {
    // Empty script is a no-op
    if (options.json) {
      console.log(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }));
    }
    process.exit(0);
  }

  // Create OverlayFS - files are mounted at /home/user/project by default
  // Read-only by default for security (use --allow-write to enable writes)
  const fs = new OverlayFs({
    root: options.root,
    readOnly: !options.allowWrite,
  });
  const mountPoint = fs.getMountPoint();

  // Use mount point as cwd unless explicitly overridden
  // Normalize --cwd to prevent path traversal (resolve . and ..)
  const cwd = options.cwdOverridden ? normalizePath(options.cwd) : mountPoint;

  // Load Tree-sitter WASM assets from vendor directory
  const vendorDir = join(__dirname, "..", "parser", "vendor");
  const treeSitterWasmConfig = {
    webTreeSitterWasm: readFileSync(join(vendorDir, "web-tree-sitter.wasm")),
    bashGrammarWasm: readFileSync(join(vendorDir, "tree-sitter-bash.wasm")),
  };

  const env = new Bash({
    fs,
    cwd,
    runtimes: {
      python: options.python,
      javascript: options.javascript,
    },
    agentic: {
      enabled: options.agentic,
    },
    parser: {
      treeSitterConfig: treeSitterWasmConfig,
    },
  });

  if (options.plan) {
    env.setMode("plan");
  }

  // Prepend set -e if errexit is enabled
  if (options.errexit) {
    script = `set -e\n${script}`;
  }

  try {
    const result = await env.exec(script);

    if (options.json) {
      console.log(
        JSON.stringify({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }),
      );
    } else {
      // Output stdout and stderr directly
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
    }

    process.exit(result.exitCode);
  } catch (e) {
    const errMsg = sanitizeErrorMessage(
      e instanceof Error ? e.message : String(e),
    );
    if (options.json) {
      console.log(
        JSON.stringify({
          stdout: "",
          stderr: errMsg,
          exitCode: 1,
        }),
      );
    } else {
      console.error(errMsg);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(
    "Fatal error:",
    sanitizeErrorMessage(e instanceof Error ? e.message : String(e)),
  );
  process.exit(1);
});
