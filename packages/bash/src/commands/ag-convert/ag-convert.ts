import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import { hasHelpFlag, showHelp } from "../help.js";

const agConvertHelp = {
  name: "ag-convert v2.3.1 (Hyperion Phase 4: Visual Intelligence)",
  summary:
    "Intelligent document and image-to-markdown converter with AI vision",
  usage: "ag-convert [OPTIONS] <FILE>",
  description: [
    "Convert documents using smart routing between IBM Docling (precision) and",
    "Microsoft MarkItDown (speed). Phase 4 adds AI-powered visual intelligence",
    "for images with multi-provider LLM support and specialized vision modes.",
    "",
    "Smart Routing Criteria:",
    "  - PDFs >1MB or with tables → Docling (high precision)",
    "  - Images, Office docs, simple files → MarkItDown (fast)",
    "",
    "Phase 4 Visual Intelligence:",
    "  - Multi-provider LLM support (OpenAI, Anthropic, Google, Local)",
    "  - Specialized vision modes (OCR, diagram, chart, UI analysis)",
    "  - Custom vision prompts for tailored image descriptions",
    "",
    "This is a 'superpower' command that requires a host Python environment",
    "with 'docling' and 'markitdown' installed.",
  ],
  options: [
    "    --analyze         Show complexity analysis without converting",
    "    --engine <auto|docling|markitdown>",
    "                      Override smart routing (default: auto)",
    "    --high-fidelity   Favor precision over speed (influences routing)",
    "    --json            Output raw structured JSON instead of Markdown",
    "",
    "  Phase 4: Visual Intelligence",
    "    --describe-images Use LLM to describe images",
    "    --llm-provider <openai|anthropic|google|local|azure>",
    "                      LLM provider (default: openai)",
    "    --llm-model <name>",
    "                      Specific model (e.g., gpt-4o, claude-3-5-sonnet)",
    "    --vision-mode <default|ocr|diagram|chart|screenshot|document|technical>",
    "                      Prompt template for image analysis",
    "    --vision-prompt <text>",
    "                      Custom vision prompt (overrides --vision-mode)",
    "",
    "  Other",
    "    --setup           Attempt to install required Python dependencies",
    "    --help            Display this help and exit",
  ],
  examples: [
    "# Basic conversion",
    "ag-convert report.pdf                    # Auto-selects best engine",
    "ag-convert data.xlsx --analyze           # Show complexity score",
    "",
    "# Phase 4: Visual Intelligence",
    "ag-convert photo.jpg --describe-images   # AI-powered image description",
    "ag-convert diagram.png --describe-images --vision-mode diagram",
    "ag-convert chart.png --vision-mode chart --llm-provider anthropic",
    "ag-convert scan.jpg --vision-mode ocr    # Extract text from image",
    "ag-convert ui.png --vision-mode screenshot --llm-model claude-3-5-sonnet",
    "",
    "# Setup",
    "ag-convert --setup                       # Install dependencies",
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
    let analyze = false;
    let describeImages = false;
    let llmProvider = "openai";
    let llmModel: string | null = null;
    let visionMode = "default";
    let visionPrompt: string | null = null;
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--engine") {
        engine = args[++i];
      } else if (arg === "--high-fidelity") {
        highFidelity = true;
      } else if (arg === "--json") {
        useJson = true;
      } else if (arg === "--analyze") {
        analyze = true;
      } else if (arg === "--describe-images") {
        describeImages = true;
      } else if (arg === "--llm-provider") {
        llmProvider = args[++i];
      } else if (arg === "--llm-model") {
        llmModel = args[++i];
      } else if (arg === "--vision-mode") {
        visionMode = args[++i];
      } else if (arg === "--vision-prompt") {
        visionPrompt = args[++i];
      } else if (!arg.startsWith("-")) {
        files.push(arg);
      }
    }

    if (files.length === 0) {
      return {
        stdout: "",
        stderr:
          "ag-convert: missing file operand\nTry 'ag-convert --help' for more information.\n",
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

    const pythonExe = "python3";

    const pythonArgs = [bridgePath, realFilePath, "--engine", engine];
    if (highFidelity) pythonArgs.push("--high-fidelity");
    if (useJson) pythonArgs.push("--json");
    if (analyze) pythonArgs.push("--analyze");
    if (describeImages) pythonArgs.push("--describe-images");

    // Phase 4: Visual Intelligence parameters
    if (llmProvider && describeImages) {
      pythonArgs.push("--llm-provider", llmProvider);
    }
    if (llmModel && describeImages) {
      pythonArgs.push("--llm-model", llmModel);
    }
    if (visionMode && describeImages) {
      pythonArgs.push("--vision-mode", visionMode);
    }
    if (visionPrompt && describeImages) {
      pythonArgs.push("--vision-prompt", visionPrompt);
    }

    try {
      const result = spawnSync(pythonExe, pythonArgs, {
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024, // 50MB
        env: { ...process.env },
      });

      if (result.error) {
        return {
          stdout: "",
          stderr: `ag-convert: failed to execute python3: ${sanitizeErrorMessage(result.error.message)}\n`,
          exitCode: 1,
        };
      }

      // Bridge failure details are already captured in result.stderr

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status ?? 0,
      };
    } catch (err: any) {
      return {
        stdout: "",
        stderr: `ag-convert: error: ${sanitizeErrorMessage(err.message)}\n`,
        exitCode: 1,
      };
    }
  },
};

function setupDependencies(): ExecResult {
  // Installing docling and markitdown using uv

  // Try to find uv in common locations if not in PATH
  // Resolve the absolute path of python3 to avoid shim mismatches
  let pythonExe = "python3";
  try {
    const resolve = spawnSync(
      "python3",
      ["-c", "import sys; print(sys.executable)"],
      { encoding: "utf-8" },
    );
    if (resolve.status === 0 && resolve.stdout.trim()) {
      pythonExe = resolve.stdout.trim();
    }
  } catch (_e) {}

  // Targeting resolved pythonExe; installing docling and markitdown

  const commonPaths = [
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
    "/opt/homebrew/Caskroom/miniconda/base/bin/uv",
    `${process.env.HOME}/.cargo/bin/uv`,
  ];

  // Try uv first if available, otherwise fallback to pip
  let uvPath = "uv";
  let foundUv = false;
  try {
    const check = spawnSync("uv", ["--version"]);
    if (check.status === 0) foundUv = true;
  } catch (_e) {}

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
    // Using uv at resolved path
    result = spawnSync(
      uvPath,
      [
        "pip",
        "install",
        "--system",
        "--python",
        pythonExe,
        "docling",
        "markitdown",
      ],
      {
        encoding: "utf-8",
        shell: true,
        env: { ...process.env },
      },
    );
  }

  if (!result || result.status !== 0) {
    if (result && result.status !== 0) {
      // uv failed — falling through to pip
    }
    // Trying pip install as fallback
    result = spawnSync(
      pythonExe,
      [
        "-m",
        "pip",
        "install",
        "docling",
        "markitdown",
        "--break-system-packages",
      ],
      {
        encoding: "utf-8",
        shell: true,
        env: { ...process.env },
      },
    );
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
