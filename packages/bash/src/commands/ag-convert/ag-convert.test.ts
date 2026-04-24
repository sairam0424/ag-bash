import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Bash } from "../../Bash.js";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("ag-convert command", () => {
  const testCsvPath = join(process.cwd(), "test_ag_convert_data.csv");
  const testCsvContent = `ID,Name,Department,Salary,Performance_Rating,Notes
101,John Doe,Engineering,125000,Exceeds Expectations,Senior Developer with focus on WASM and AI Integration
102,Jane Smith,Product,115000,Outstanding,Product Manager for Ag-Bash project. Great at cross-functional communication.
103,Bob Wilson,Design,95000,Meets Expectations,Lead UI Designer. Responsible for the new glassmorphism theme.
104,Alice Brown,Research,140000,Exceptional,ML Researcher working on the Hyperion Document Intelligence layer.`;

  beforeAll(() => {
    // Create test CSV file
    writeFileSync(testCsvPath, testCsvContent);
  });

  afterAll(() => {
    // Cleanup test file
    if (existsSync(testCsvPath)) {
      unlinkSync(testCsvPath);
    }
  });

  describe("basic conversion", () => {
    it("should convert CSV with high-fidelity flag", async () => {
      const env = new Bash();
      const result = await env.exec(`ag-convert ${testCsvPath} --high-fidelity`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ID");
      expect(result.stdout).toContain("Name");
      expect(result.stdout).toContain("Department");
      expect(result.stdout).toContain("John Doe");
      expect(result.stdout).toContain("Jane Smith");
      expect(result.stdout).toContain("Engineering");
      expect(result.stderr).not.toContain("Error");
    });

    it("should convert CSV without high-fidelity flag", async () => {
      const env = new Bash();
      const result = await env.exec(`ag-convert ${testCsvPath}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("John Doe");
      expect(result.stdout).toContain("Jane Smith");
    });

    it("should respect --engine markitdown flag", async () => {
      const env = new Bash();
      const result = await env.exec(`ag-convert ${testCsvPath} --engine markitdown`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("John Doe");
      expect(result.stdout).toContain("Jane Smith");
    });

    it("should respect --engine docling flag", async () => {
      const env = new Bash();
      const result = await env.exec(`ag-convert ${testCsvPath} --engine docling`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("John Doe");
      expect(result.stdout).toContain("Jane Smith");
    });

    it("should output JSON when --json flag is used with docling", async () => {
      const env = new Bash();
      const result = await env.exec(`ag-convert ${testCsvPath} --json --engine docling`);

      expect(result.exitCode).toBe(0);
      // Should be valid JSON
      expect(() => JSON.parse(result.stdout)).not.toThrow();

      const json = JSON.parse(result.stdout);
      expect(json).toBeDefined();
    });
  });

  describe("help and usage", () => {
    it("should show help with --help flag", async () => {
      const env = new Bash();
      const result = await env.exec("ag-convert --help");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ag-convert");
      expect(result.stdout).toContain("Hyperion");
      expect(result.stdout).toContain("--high-fidelity");
      expect(result.stdout).toContain("--engine");
      expect(result.stdout).toContain("--json");
      expect(result.stdout).toContain("--setup");
    });

    it("should show version in help", async () => {
      const env = new Bash();
      const result = await env.exec("ag-convert --help");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("v2.1.0");
    });
  });

  describe("error handling", () => {
    it("should error on missing file", async () => {
      const env = new Bash();
      const result = await env.exec("ag-convert /nonexistent/file.csv");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("File not found");
    });

    it("should error when no file is provided", async () => {
      const env = new Bash();
      const result = await env.exec("ag-convert");

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("missing file operand");
      expect(result.stderr).toContain("--help");
    });

    it("should handle invalid engine gracefully", async () => {
      const env = new Bash();
      // Invalid engine values are passed to argparse which will error
      const result = await env.exec(`ag-convert ${testCsvPath} --engine invalid_engine`);

      // Python argparse will catch this
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("file format detection", () => {
    it("should handle relative paths", async () => {
      const env = new Bash();
      // Copy file to a relative location in the virtual fs
      await env.exec(`echo "${testCsvContent}" > relative_test.csv`);

      const result = await env.exec("ag-convert relative_test.csv");

      expect(result.stdout).toContain("John Doe");
    });

    it("should handle absolute paths", async () => {
      const env = new Bash();
      const result = await env.exec(`ag-convert ${testCsvPath}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("John Doe");
    });
  });

  describe("option combinations", () => {
    it("should handle --high-fidelity with --engine docling", async () => {
      const env = new Bash();
      const result = await env.exec(`ag-convert ${testCsvPath} --high-fidelity --engine docling`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("John Doe");
    });

    it("should handle --high-fidelity with --json", async () => {
      const env = new Bash();
      const result = await env.exec(`ag-convert ${testCsvPath} --high-fidelity --json`);

      expect(result.exitCode).toBe(0);
      // Should be valid JSON
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });

    it("should handle all flags together", async () => {
      const env = new Bash();
      const result = await env.exec(`ag-convert ${testCsvPath} --engine docling --high-fidelity --json`);

      expect(result.exitCode).toBe(0);
      // Should be valid JSON
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });
  });

  describe("output format validation", () => {
    it("should produce markdown table with proper formatting", async () => {
      const env = new Bash();
      const result = await env.exec(`ag-convert ${testCsvPath} --high-fidelity`);

      expect(result.exitCode).toBe(0);
      // Should contain table structure
      expect(result.stdout).toMatch(/\|.*\|/); // Contains pipe characters (table)
      expect(result.stdout).toMatch(/[-]+/);    // Contains dashes (table separator)
    });

    it("should preserve data integrity", async () => {
      const env = new Bash();
      const result = await env.exec(`ag-convert ${testCsvPath} --high-fidelity`);

      expect(result.exitCode).toBe(0);

      // All critical data should be present
      expect(result.stdout).toContain("101");
      expect(result.stdout).toContain("102");
      expect(result.stdout).toContain("103");
      expect(result.stdout).toContain("104");
      expect(result.stdout).toContain("125000");
      expect(result.stdout).toContain("115000");
      expect(result.stdout).toContain("Exceeds Expectations");
      expect(result.stdout).toContain("Outstanding");
    });

    it("should handle long text fields properly", async () => {
      const env = new Bash();
      const result = await env.exec(`ag-convert ${testCsvPath} --high-fidelity`);

      expect(result.exitCode).toBe(0);

      // Long notes should be preserved
      expect(result.stdout).toContain("Senior Developer with focus on WASM and AI Integration");
      expect(result.stdout).toContain("ML Researcher working on the Hyperion Document Intelligence layer");
    });
  });
});
