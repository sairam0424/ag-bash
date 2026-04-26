import { z } from "zod";
import { Tool, type ToolboxTool } from "./Tool.js";
import { buildTool } from "./BashToolbox.js";
import { agConvertCommand } from "../commands/ag-convert/ag-convert.js";
import type { Bash } from "../Bash.js";

/**
 * ag_convert - Agentic tool for high-precision document and image conversion.
 */
export const ConvertTool: ToolboxTool = buildTool({
  name: "ag_convert",
  description: "Convert documents (PDF, Docx, Xlsx) and images to Markdown with AI-powered visual intelligence and OCR.",
  parameters: z.object({
    filePath: z.string().describe("Path to the file to convert."),
    engine: z.enum(["auto", "docling", "markitdown"]).optional().describe("Engine override (default: auto)."),
    highFidelity: z.boolean().optional().describe("Favor precision over speed (default: false)."),
    describeImages: z.boolean().optional().describe("Use AI to describe images (default: false)."),
    visionMode: z.enum(["default", "ocr", "diagram", "chart", "screenshot", "document", "technical"]).optional().describe("Prompt template for image analysis."),
    visionPrompt: z.string().optional().describe("Custom vision prompt (overrides visionMode)."),
    llmProvider: z.enum(["openai", "anthropic", "google", "local", "azure"]).optional().describe("LLM provider for vision tasks."),
    llmModel: z.string().optional().describe("Specific model for vision tasks."),
  }),
  effort: "high",
  execute: async (bash: Bash, args: any) => {
    const cmdArgs = [args.filePath];
    if (args.engine) cmdArgs.push("--engine", args.engine);
    if (args.highFidelity) cmdArgs.push("--high-fidelity");
    if (args.describeImages) cmdArgs.push("--describe-images");
    if (args.visionMode) cmdArgs.push("--vision-mode", args.visionMode);
    if (args.visionPrompt) cmdArgs.push("--vision-prompt", args.visionPrompt);
    if (args.llmProvider) cmdArgs.push("--llm-provider", args.llmProvider);
    if (args.llmModel) cmdArgs.push("--llm-model", args.llmModel);

    // Reuse existing command logic
    const result = await agConvertCommand.execute(cmdArgs, {
      fs: bash.fs,
      cwd: bash.cwd,
      env: bash.env,
      stdin: "",
      bash,
    } as any);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Conversion failed with exit code ${result.exitCode}`);
    }

    return result.stdout;
  },
});
