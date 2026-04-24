import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agConvertHelp = {
  name: "ag-convert v2.1.0 (Hyperion-Debug)",
  summary: "Hybrid high-fidelity document-to-markdown converter (Hyperion)",
  usage: "ag-convert [OPTIONS] <FILE>",
  description: [
    "Convert any document (PDF, DOCX, XLSX, Images) to Markdown using a hybrid",
    "routing engine powered by IBM Docling and Microsoft MarkItDown.",
    "",
    "This is a 'superpower' command that requires a host Python environment",
    "with 'docling' and 'markitdown' installed.",
  ],
  options: [
    "    --engine <auto|docling|markitdown>",
    "                      Select conversion engine (default: auto)",
    "    --high-fidelity   Favor structural precision (Docling) for tables/PDFs",
    "    --json            Output raw structured JSON instead of Markdown",
    "    --setup           Attempt to install required Python dependencies",
    "    --help            Display this help and exit",
  ],
  examples: [
    "ag-convert report.pdf",
    "ag-convert data.xlsx --high-fidelity",
    "ag-convert --engine markitdown image.png",
    "ag-convert --setup",
  ],
};

export const agConvertCommand: Command = {
  name: "ag-convert",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(agConvertHelp);
    }

    if (args.includes("--setup")) {
      return setupDependencies();
    }

    let engine = "auto";
    let highFidelity = false;
    let useJson = false;
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--engine") {
        engine = args[++i];
      } else if (arg === "--high-fidelity") {
        highFidelity = true;
      } else if (arg === "--json") {
        useJson = true;
      } else if (!arg.startsWith("-")) {
        files.push(arg);
      }
    }

    if (files.length === 0) {
      return {
        stdout: "",
        stderr: "ag-convert: missing file operand\nTry 'ag-convert --help' for more information.\n",
        exitCode: 2,
      };
    }

    // Resolve bridge script path
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Resolve relative path to absolute virtual path
    const virtualPath = ctx.fs.resolvePath(ctx.cwd, files[0]);

    // For host-side tools like Hyperion, we need to translate the virtual path back to a real host path
    let realFilePath = virtualPath;
    
    if (typeof ctx.fs.toRealPath === "function") {
      const resolved = ctx.fs.toRealPath(virtualPath);
      if (resolved) {
        realFilePath = resolved;
      }
    }

    const exists = await ctx.fs.exists(virtualPath);

    if (!exists) {
      return {
        stdout: "",
        stderr: `Error: File not found: ${virtualPath}\n`,
        exitCode: 1,
      };
    }

    const bridgePath = join(__dirname, "hyperion_bridge.py");

    if (!existsSync(bridgePath)) {
      return {
        stdout: "",
        stderr: "ag-convert: internal error: configuration missing\n",
        exitCode: 1,
      };
    }

    // Call host python
    // Resolve the absolute path of python3 to avoid shim mismatches
    let pythonExe = "python3";
    try {
      const resolve = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf-8" });
      if (resolve.status === 0 && resolve.stdout.trim()) {
        pythonExe = resolve.stdout.trim();
      }
    } catch (e) {}

    const pythonArgs = [
      bridgePath,
      realFilePath,
      "--engine", engine
    ];
    if (highFidelity) pythonArgs.push("--high-fidelity");
    if (useJson) pythonArgs.push("--json");

    try {
      const result = spawnSync(pythonExe, pythonArgs, {
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024, // 50MB
        env: { ...process.env }
      });

      if (result.error) {
        return {
          stdout: "",
          stderr: `ag-convert: failed to execute python3: ${result.error.message}\n`,
          exitCode: 1,
        };
      }

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status ?? 0,
      };
    } catch (err: any) {
      return {
        stdout: "",
        stderr: `ag-convert: error: ${err.message}\n`,
        exitCode: 1,
      };
    }
  },
};

function setupDependencies(): ExecResult {
  console.log("Hyperion Setup: Installing docling and markitdown using uv...");
  
  // Try to find uv in common locations if not in PATH
  // Resolve the absolute path of python3 to avoid shim mismatches
  let pythonExe = "python3";
  try {
    const resolve = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf-8" });
    if (resolve.status === 0 && resolve.stdout.trim()) {
      pythonExe = resolve.stdout.trim();
    }
  } catch (e) {}

  console.log(`Hyperion Setup: Targeting Python at ${pythonExe}`);
  console.log("Installing docling and markitdown...");
  
  const commonPaths = [
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
    "/opt/homebrew/Caskroom/miniconda/base/bin/uv",
    process.env.HOME + "/.cargo/bin/uv"
  ];
  
  // Try uv first if available, otherwise fallback to pip
  let uvPath = "uv";
  let foundUv = false;
  try {
    const check = spawnSync("uv", ["--version"]);
    if (check.status === 0) foundUv = true;
  } catch (e) {}

  if (!foundUv) {
    for (const path of commonPaths) {
      if (existsSync(path)) {
        uvPath = path;
        foundUv = true;
        break;
      }
    }
  }

  let result;
  if (foundUv) {
    console.log(`Using uv at: ${uvPath}`);
    result = spawnSync(uvPath, ["pip", "install", "--system", "--python", pythonExe, "docling", "markitdown"], { 
      encoding: "utf-8",
      shell: true,
      env: { ...process.env }
    });
  }

  if (!result || result.status !== 0) {
    if (result && result.status !== 0) {
      console.log(`uv failed with exit code ${result.status}. Error: ${result.stderr}`);
    }
    console.log(`Trying ${pythonExe} -m pip install...`);
    result = spawnSync(pythonExe, ["-m", "pip", "install", "docling", "markitdown", "--break-system-packages"], { 
      encoding: "utf-8",
      shell: true,
      env: { ...process.env }
    });
  }

  if (result.status === 0) {
    return {
      stdout: "Successfully installed docling and markitdown.\n",
      stderr: "",
      exitCode: 0,
    };
  } else {
    return {
      stdout: "",
      stderr: `Setup failed:\n${result.stderr}\nPlease install manually using uv: uv pip install docling markitdown\n`,
      exitCode: 1,
    };
  }
}
