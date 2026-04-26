import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(__dirname, "../../dist/bin/ag-bash.js");
const testDir = resolve(__dirname, "../../scratch/e2e-v-next");

async function runBin(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [binPath, ...args],
      {
        env: { ...process.env, AZURE_OPENAI_API_KEY: "mock", AZURE_OPENAI_ENDPOINT: "https://mock.azure.com" },
      },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.code ?? 1,
    };
  }
}

describe("Ag-Bash V-Next E2E Tests", () => {
  beforeAll(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    fs.writeFileSync(join(testDir, "hello.txt"), "Hello World\n");
    fs.writeFileSync(join(testDir, "edit_me.ts"), "export const a = 1;\nexport const b = 2;\n");
  });

  it("should show agentic status in help", async () => {
    const result = await runBin(["--help"]);
    expect(result.stdout).toContain("AGENTIC");
  });

  it("should support ag-grep command", async () => {
    const result = await runBin(["--agentic", "--root", testDir, "-c", "ag-grep Hello ."]);
    expect(result.stdout).toContain("hello.txt");
    expect(result.stdout).toContain("Hello World");
  });

  it("should support ag-find-files command", async () => {
    const result = await runBin(["--agentic", "--root", testDir, "-c", "ag-find-files . *.ts"]);
    expect(result.stdout).toContain("edit_me.ts");
  });

  it("should enforce plan mode (read-only for destructive tools)", async () => {
    const result = await runBin([
      "--agentic",
      "--plan",
      "--allow-write", // Even with allow-write, plan mode should block it
      "--root",
      testDir,
      "-c",
      "touch new_file.txt",
    ]);
    expect(result.stderr).toContain("security violation");
    expect(result.stderr).toContain("blocked in 'plan' mode");
  });

  it("should support ag-edit command", async () => {
    const result = await runBin([
      "--agentic",
      "--allow-write",
      "--root",
      testDir,
      "-c",
      'ag-edit replace edit_me.ts --line 1 --text "export const a = 10;" && cat edit_me.ts',
    ]);
    expect(result.stdout).toContain("Successfully updated edit_me.ts");
    expect(result.stdout).toContain("export const a = 10;");
  });

  it("should support ag-grep on large files", async () => {
    const largeFile = resolve(testDir, "large.txt");
    let content = "";
    for (let i = 0; i < 1000; i++) {
      content += `Line ${i}: Searchable content\n`;
    }
    fs.writeFileSync(largeFile, content);

    const result = await runBin([
      "--agentic",
      "--root",
      testDir,
      "-c",
      "ag-grep 'Line 999' .",
    ]);

    expect(result.stdout).toContain("Line 999: Searchable content");
  });
});

function join(...parts: string[]): string {
  return parts.join("/");
}
