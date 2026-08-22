/**
 * README and AGENTS.md validation tests
 *
 * Ensures documentation stays in sync with the actual codebase:
 * 1. Command list is complete and accurate
 * 2. TypeScript examples compile correctly
 * 3. Bash examples execute correctly
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";
import {
  getCommandNames,
  getJavaScriptCommandNames,
  getNetworkCommandNames,
  getPythonCommandNames,
} from "./commands/registry.js";

const README_PATH = path.join(import.meta.dirname, "..", "README.md");
const AGENTS_PATH = path.join(import.meta.dirname, "..", "AGENTS.npm.md");
const TRANSFORM_README_PATH = path.join(
  import.meta.dirname,
  "transform",
  "README.md",
);

function parseReadme(): string {
  return fs.readFileSync(README_PATH, "utf-8");
}

function parseAgents(): string {
  return fs.readFileSync(AGENTS_PATH, "utf-8");
}

function parseTransformReadme(): string {
  return fs.readFileSync(TRANSFORM_README_PATH, "utf-8");
}

/**
 * Extract bash code blocks from markdown
 */
function extractBashBlocks(content: string): string[] {
  const blocks: string[] = [];
  const pattern = /```bash\n([\s\S]*?)```/g;

  for (const match of content.matchAll(pattern)) {
    blocks.push(match[1]);
  }

  return blocks;
}

/**
 * Extract command names from README "Supported Commands" section
 */
function extractReadmeCommands(readme: string): Set<string> {
  const commands = new Set<string>();

  // Find the "Supported Commands" section (stop at "All commands support")
  const supportedMatch = readme.match(
    /Supported Commands[\s\S]*?\n([\s\S]*?)(?=\nAll commands support|\n## [A-Z]|\n---|\$)/,
  );
  if (!supportedMatch) {
    throw new Error("Could not find 'Supported Commands' section in README");
  }

  const section = supportedMatch[1];

  // Extract all backtick-quoted command names
  // Matches: `cmd`, `cmd` (+ `alias1`, `alias2`)
  const cmdPattern = /`([a-z0-9_-]+)`/g;
  for (const match of section.matchAll(cmdPattern)) {
    commands.add(match[1]);
  }

  return commands;
}

/**
 * Extract command names from AGENTS.npm.md "Available Commands" section
 */
function extractAgentsCommands(agents: string): Set<string> {
  const commands = new Set<string>();

  // Find the "Available Commands" section (stop at "All commands support" or next ## heading)
  const supportedMatch = agents.match(
    /## Available Commands\n([\s\S]*?)(?=\nAll commands support|\n## [A-Z]|\$)/,
  );
  if (!supportedMatch) {
    throw new Error(
      "Could not find 'Available Commands' section in AGENTS.npm.md",
    );
  }

  const section = supportedMatch[1];

  // Extract all backtick-quoted command names
  const cmdPattern = /`([a-z0-9_-]+)`/g;
  for (const match of section.matchAll(cmdPattern)) {
    commands.add(match[1]);
  }

  return commands;
}

/**
 * Extract TypeScript code blocks from markdown
 */
function extractTypeScriptBlocks(content: string): string[] {
  const blocks: string[] = [];
  const pattern = /```typescript\n([\s\S]*?)```/g;

  for (const match of content.matchAll(pattern)) {
    blocks.push(match[1]);
  }

  return blocks;
}

/**
 * Rename duplicate const/let declarations to avoid redeclaration errors
 * e.g., if "const env" appears twice, the second becomes "const env_2"
 */
function renameDuplicateDeclarations(code: string): string {
  const varCounts = new Map<string, number>();
  // Match const/let declarations like "const env =" or "const env="
  return code.replace(
    /\b(const|let)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g,
    (match, keyword, varName) => {
      const count = (varCounts.get(varName) || 0) + 1;
      varCounts.set(varName, count);
      if (count > 1) {
        return `${keyword} ${varName}_${count} =`;
      }
      return match;
    },
  );
}

/**
 * Add implied imports to a code block and wrap non-import code in async IIFE
 * to avoid redeclaration errors between examples.
 *
 * Deliberately does NOT emit `// @ts-nocheck`. An earlier version prepended it
 * to `imports`, which then landed *after* the block's own imports (because the
 * two lists were concatenated as `[...existingImports, ...newImports]`) and was
 * therefore inert — TypeScript only honours the pragma in a file's leading
 * comment block. Putting it back in the right place would silently neuter the
 * whole compile check, so it is gone instead.
 *
 * Implied imports are only added for identifiers that are genuinely exported
 * from the package root; the specifier must be a real entry point in the
 * `exports` map of packages/bash/package.json, otherwise the harness would
 * manufacture failures for examples that are perfectly valid.
 */
function addImpliedImports(code: string): string {
  const imports: string[] = [];

  // Check what's used and add appropriate imports. All of these are root
  // exports of @ag-bash/bash (see src/index.ts).
  const impliedRootExports = ["Bash", "defineCommand", "Sandbox"];
  for (const name of impliedRootExports) {
    if (code.includes(name) && !code.includes('from "@ag-bash/bash"')) {
      imports.push(`import { ${name} } from "@ag-bash/bash";`);
    }
  }

  // Extract existing imports from code
  const existingImports = code.match(/^import .*/gm) || [];
  const codeWithoutImports = code.replace(/^import .*\n?/gm, "").trim();

  // Filter out imports that are already present
  const newImports = imports.filter(
    (imp) => !existingImports.some((existing) => existing.includes(imp)),
  );

  // Combine all imports
  const allImports = [...existingImports, ...newImports];

  // Rename duplicate variable declarations to avoid redeclaration errors
  const scopedCode = renameDuplicateDeclarations(codeWithoutImports);

  // Wrap non-import code in async IIFE to create separate scope
  const wrappedCode = `(async () => {\n${scopedCode}\n})();`;

  if (allImports.length === 0) {
    return wrappedCode;
  }

  return `${allImports.join("\n")}\n\n${wrappedCode}`;
}

/** Absolute path to the real `@ag-bash/bash` package root. */
const PACKAGE_ROOT = path.join(import.meta.dirname, "..");
const PACKAGE_NAME = "@ag-bash/bash";

/**
 * Map every entry point declared in the real `exports` map of
 * packages/bash/package.json onto its REAL source module, for use as tsconfig
 * `paths`. Documentation examples are then type-checked against the actual
 * public surface instead of a hand-written stub.
 *
 * Derived from `exports` rather than hardcoded on purpose: a newly added
 * subpath is picked up automatically. `./agent-runtime` was exactly this case —
 * a real, published entry point that the old hand-written stub knew nothing
 * about, so a correct README example failed to compile.
 *
 * The mapping targets the sources rather than the emitted declarations because
 * `dist/` only exists after `pnpm build` and this file also runs in the unit
 * lane on a plain checkout. Each `dist/<x>.d.ts` is generated from `src/<x>.ts`
 * by `tsc`, so the surface being checked is the same one consumers get.
 */
function resolveRealPackagePaths(): Map<string, string> {
  const manifestPath = path.join(PACKAGE_ROOT, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
    exports?: unknown;
  };
  const exportsMap = manifest.exports;
  if (typeof exportsMap !== "object" || exportsMap === null) {
    throw new Error(`No "exports" map found in ${manifestPath}`);
  }

  const resolved = new Map<string, string>();
  for (const [subpath, conditions] of Object.entries(exportsMap)) {
    if (typeof conditions !== "object" || conditions === null) continue;
    const entry = conditions as {
      import?: { types?: unknown };
      require?: { types?: unknown };
    };
    const types = entry.import?.types ?? entry.require?.types;
    if (typeof types !== "string") continue;

    // "./dist/agent-runtime/index.d.ts" -> "src/agent-runtime/index.ts"
    const sourceRelative = types
      .replace(/^\.\/dist\//, "src/")
      .replace(/\.d\.ts$/, ".ts");
    const sourceAbsolute = path.join(PACKAGE_ROOT, sourceRelative);
    if (!fs.existsSync(sourceAbsolute)) {
      throw new Error(
        `exports["${subpath}"] declares types "${types}" but the source it is ` +
          `generated from (${sourceRelative}) does not exist. ` +
          "Update this test's dist->src mapping.",
      );
    }

    const specifier =
      subpath === "."
        ? PACKAGE_NAME
        : `${PACKAGE_NAME}/${subpath.replace(/^\.\//, "")}`;
    resolved.set(specifier, sourceAbsolute);
  }

  if (!resolved.has(PACKAGE_NAME)) {
    throw new Error(`exports map in ${manifestPath} has no "." entry`);
  }
  return resolved;
}

/**
 * Collect `.d.ts` files under the package source that declare an *external*
 * (non-relative) ambient module — e.g. `src/observability/opentelemetry-api.d.ts`
 * declares `@opentelemetry/api`, an intentionally-uninstalled optional
 * dependency. The real sources import those specifiers, so without these files
 * in the program the whole graph fails to resolve with TS2307.
 */
function collectAmbientModuleDeclarations(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectAmbientModuleDeclarations(full));
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;
    if (/declare\s+module\s+["'](?!\.)/.test(fs.readFileSync(full, "utf-8"))) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Type-check TypeScript blocks from multiple sources in a single tsc invocation
 * and return the raw `error TS...` lines (empty when everything compiles).
 */
function typeCheckTypeScriptBlocks(
  blocksBySource: Array<{ source: string; blocks: string[] }>,
): string[] {
  const rootDir = path.join(import.meta.dirname, "..", "..", "..");
  // Fixed name: `.docs-test-tmp/` is the directory the repo .gitignore covers.
  const tmpDir = path.join(rootDir, ".docs-test-tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const files: string[] = [];

    // Write all blocks from all sources to files
    for (const { source, blocks } of blocksBySource) {
      for (let i = 0; i < blocks.length; i++) {
        const code = addImpliedImports(blocks[i]);
        const fileName = `${source.replace(/[^a-z0-9]/gi, "-")}-${i}.ts`;
        const filePath = path.join(tmpDir, fileName);
        fs.writeFileSync(filePath, code);
        files.push(filePath);
      }
    }

    if (files.length === 0) return [];

    // Only genuinely third-party packages are stubbed. `ai` (the Vercel AI SDK)
    // is an optional peer that this monorepo does not install, and its surface
    // is not ours to validate. Everything under "@ag-bash/bash" resolves to the
    // REAL sources via tsconfig `paths` below — never to a stub.
    const thirdPartyDeclarations = `
declare module "ai" {
  export function generateText(options: {
    model: string;
    tools?: unknown;
    prompt: string;
    maxSteps?: number;
  }): Promise<{ text: string; steps?: unknown[] }>;
  export function streamText(options: {
    model: string;
    tools?: unknown;
    prompt: string;
  }): { textStream: AsyncIterable<string> };
}
`;
    const declarationsPath = path.join(tmpDir, "third-party.d.ts");
    fs.writeFileSync(declarationsPath, thirdPartyDeclarations);

    const paths: Record<string, string[]> = Object.create(null);
    for (const [specifier, sourceFile] of resolveRealPackagePaths()) {
      paths[specifier] = [sourceFile];
    }

    // Mirror the package's own compiler settings (strict, bundler resolution).
    // Loosening `strict` is not an option: with `strictNullChecks` off, the
    // real sources stop narrowing their discriminated-union results and emit
    // hundreds of spurious internal TS2339s that have nothing to do with the
    // documentation being checked.
    const tsconfig = {
      compilerOptions: {
        baseUrl: ".",
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        resolveJsonModule: true,
        paths,
      },
      include: [
        ...files,
        declarationsPath,
        ...collectAmbientModuleDeclarations(path.join(PACKAGE_ROOT, "src")),
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify(tsconfig, null, 2),
    );

    // Run tsc once to check all files
    try {
      execSync("npx tsc --project tsconfig.json", {
        cwd: tmpDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
      return [];
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string };
      const output = execError.stdout || execError.stderr || "";
      return output.split("\n").filter((line) => line.includes("error TS"));
    }
  } finally {
    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Compile TypeScript blocks from multiple sources and fail on any error.
 */
function compileTypeScriptBlocks(
  blocksBySource: Array<{ source: string; blocks: string[] }>,
): void {
  const errorLines = typeCheckTypeScriptBlocks(blocksBySource);

  if (errorLines.length > 0) {
    expect.fail(
      `TypeScript errors in documentation examples:\n${errorLines.slice(0, 10).join("\n")}` +
        (errorLines.length > 10
          ? `\n... and ${errorLines.length - 10} more`
          : ""),
    );
  }
}

describe("README validation", () => {
  describe("command list completeness", () => {
    it("should list all registered commands", () => {
      const readme = parseReadme();
      const readmeCommands = extractReadmeCommands(readme);
      const registryCommands = new Set([
        ...getCommandNames(),
        ...getNetworkCommandNames(),
        ...getPythonCommandNames(),
        ...getJavaScriptCommandNames(),
      ]);

      // Stub commands that redirect to other commands — not documented separately
      const stubs = new Set(["node"]); // redirects to js-exec

      // Commands in registry but not in README
      const missingFromReadme: string[] = [];
      for (const cmd of registryCommands) {
        if (!readmeCommands.has(cmd) && !stubs.has(cmd)) {
          missingFromReadme.push(cmd);
        }
      }

      // Commands in README but not in registry
      const extraInReadme: string[] = [];
      for (const cmd of readmeCommands) {
        if (!registryCommands.has(cmd)) {
          extraInReadme.push(cmd);
        }
      }

      // Check for missing commands (not in README)
      if (missingFromReadme.length > 0) {
        expect.fail(
          `Commands missing from README: ${missingFromReadme.join(", ")}\n` +
            "Add these to the 'Supported Commands' section in README.md",
        );
      }

      // Check for extra commands (in README but not registered)
      // Filter out known aliases and special cases
      const knownExtras = new Set([
        "cd", // builtin, not a command
        "export", // builtin, not a command
      ]);
      const realExtras = extraInReadme.filter((cmd) => !knownExtras.has(cmd));

      if (realExtras.length > 0) {
        expect.fail(
          `Commands in README but not in registry: ${realExtras.join(", ")}\n` +
            "Either add these to the registry or remove from README.md",
        );
      }
    });

    it("should have a reasonable number of commands", () => {
      const readme = parseReadme();
      const readmeCommands = extractReadmeCommands(readme);

      // Sanity check - we should have a good number of commands
      expect(readmeCommands.size).toBeGreaterThan(40);
      expect(readmeCommands.size).toBeLessThan(150);
    });
  });
});

describe("AGENTS.npm.md validation", () => {
  describe("command list completeness", () => {
    it("should list all registered commands", () => {
      const agents = parseAgents();
      const agentsCommands = extractAgentsCommands(agents);
      const registryCommands = new Set([
        ...getCommandNames(),
        ...getNetworkCommandNames(),
        ...getPythonCommandNames(),
        ...getJavaScriptCommandNames(),
      ]);

      // Stub commands that redirect to other commands — not documented separately
      const stubs = new Set(["node"]); // redirects to js-exec

      // Commands in registry but not in AGENTS.npm.md
      const missingFromAgents: string[] = [];
      for (const cmd of registryCommands) {
        if (!agentsCommands.has(cmd) && !stubs.has(cmd)) {
          missingFromAgents.push(cmd);
        }
      }

      // Commands in AGENTS.npm.md but not in registry
      const extraInAgents: string[] = [];
      for (const cmd of agentsCommands) {
        if (!registryCommands.has(cmd)) {
          extraInAgents.push(cmd);
        }
      }

      // Check for missing commands (not in AGENTS.npm.md)
      if (missingFromAgents.length > 0) {
        expect.fail(
          `Commands missing from AGENTS.npm.md: ${missingFromAgents.join(", ")}\n` +
            "Add these to the 'Available Commands' section in AGENTS.npm.md",
        );
      }

      // Check for extra commands (in AGENTS.npm.md but not registered)
      if (extraInAgents.length > 0) {
        expect.fail(
          `Commands in AGENTS.npm.md but not in registry: ${extraInAgents.join(", ")}\n` +
            "Either add these to the registry or remove from AGENTS.npm.md",
        );
      }
    });
  });
});

describe("Documentation TypeScript examples", () => {
  it("should have TypeScript code blocks in README", () => {
    const readme = parseReadme();
    const blocks = extractTypeScriptBlocks(readme);
    expect(blocks.length).toBeGreaterThan(5);
  });

  it("should have TypeScript code blocks in AGENTS.npm.md", () => {
    const agents = parseAgents();
    const blocks = extractTypeScriptBlocks(agents);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("should have TypeScript code blocks in transform README", () => {
    const transformReadme = parseTransformReadme();
    const blocks = extractTypeScriptBlocks(transformReadme);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("should have valid TypeScript syntax in all examples", {
    timeout: 30000,
  }, () => {
    const readme = parseReadme();
    const agents = parseAgents();
    const transformReadme = parseTransformReadme();

    // Compile all TypeScript blocks from both files in a single tsc run
    compileTypeScriptBlocks([
      { source: "README", blocks: extractTypeScriptBlocks(readme) },
      { source: "AGENTS", blocks: extractTypeScriptBlocks(agents) },
      {
        source: "transform-README",
        blocks: extractTypeScriptBlocks(transformReadme),
      },
    ]);
  });

  // Negative control for the check above. It resolves "@ag-bash/bash" to the
  // real sources, so it must reject an example that names an export the package
  // does not have. Without this guard the compile check could silently rot into
  // a no-op (an inert `// @ts-nocheck`, an over-permissive stub, a `paths` entry
  // pointing at nothing) and still report green.
  it("should reject an example that imports a nonexistent export", {
    timeout: 30000,
  }, () => {
    const errorLines = typeCheckTypeScriptBlocks([
      {
        source: "negative-control",
        blocks: [
          'import { thisExportDoesNotExist } from "@ag-bash/bash";\n' +
            "console.log(thisExportDoesNotExist);\n",
        ],
      },
    ]);

    expect(errorLines.join("\n")).toContain("thisExportDoesNotExist");
  });
});

describe("AGENTS.npm.md Bash examples", () => {
  it("should have bash code blocks", () => {
    const agents = parseAgents();
    const blocks = extractBashBlocks(agents);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("should execute bash examples without errors", async () => {
    const agents = parseAgents();
    const blocks = extractBashBlocks(agents);

    // Set up a bash environment with sample data for the examples
    const bash = new Bash({
      files: {
        "/data/input.txt": "hello world\ntest pattern\nfoo bar\n",
        "/data/data.json":
          '{"items": [{"name": "a", "active": true}, {"name": "b", "active": false}], "name": "test", "users": [{"active": true, "role": "admin"}, {"active": false, "role": "user"}]}',
        "/data/data.csv":
          "name,category,value,status\nalice,A,10,active\nbob,B,20,inactive\n",
        "/data/config.yaml":
          "config:\n  database:\n    host: localhost\n    port: 5432\nusers:\n  - name: alice\n    role: admin\n  - name: bob\n    role: user\n",
        "/data/data.yaml": "name: test\nvalue: 42\n",
        "/data/users.yaml":
          "users:\n  - name: alice\n    role: admin\n  - name: bob\n    role: user\n",
        "/data/data.xml":
          '<root><users><user><name>alice</name></user></users><item id="123">test</item></root>',
        "/data/config.ini": "[database]\nhost=localhost\nport=5432\n",
        "/data/page.html": "<h1>Title</h1><p>Some text content</p>",
        // TOML files
        "/data/Cargo.toml":
          '[package]\nname = "my-project"\nversion = "1.0.0"\n\n[dependencies]\nserde = "1.0"\n',
        "/data/pyproject.toml":
          '[tool.poetry]\nname = "my-package"\nversion = "2.0.0"\n\n[tool.poetry.dependencies]\npython = "^3.9"\n',
        "/data/config.toml":
          '[server]\nhost = "localhost"\nport = 8080\n\n[database]\nurl = "postgres://localhost/db"\n',
        // TSV file
        "/data/data.tsv": "name\tcategory\tvalue\nalice\tA\t10\nbob\tB\t20\n",
        // Front-matter files
        "/data/post.md":
          "---\ntitle: My Post\nauthor: Alice\ntags:\n  - coding\n  - tutorial\n---\n\n# Content here\n\nThis is the body of the post.\n",
        "/data/blog-post.md":
          "---\ntitle: Blog Post\ntags:\n  - tech\n  - news\n---\n\n# Blog content\n",
        "/data/hugo-post.md":
          '+++\ntitle = "Hugo Post"\ndate = "2024-01-01"\ndraft = false\n+++\n\n# Hugo content\n',
        "/src/app.ts": "// TODO: implement\nexport const x = 1;",
        "/src/lib.ts": "// helper\nexport const y = 2;",
        // Mock type definition files for "Discovering Types" examples
        "/data/node_modules/@ag-bash/bash/dist/index.d.ts":
          'export { Bash } from "./Bash";\nexport type { BashOptions } from "./Bash";',
        "/data/node_modules/@ag-bash/bash/dist/Bash.d.ts":
          "export interface BashOptions {\n  files?: Record<string, string>;\n  cwd?: string;\n  env?: Record<string, string>;\n}\nexport interface ExecResult {\n  stdout: string;\n  stderr: string;\n  exitCode: number;\n}\nexport class Bash {\n  constructor(options?: BashOptions);\n  exec(command: string): Promise<ExecResult>;\n}",
        "/data/node_modules/@ag-bash/bash/dist/ai/index.d.ts":
          "export interface CreateBashToolOptions {\n  files?: Record<string, string>;\n  network?: { allowedUrlPrefixes: string[] };\n}\nexport function createBashTool(options?: CreateBashToolOptions): Tool;",
      },
      cwd: "/data",
    });

    for (const block of blocks) {
      // Extract individual commands from the block
      const commands = block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));

      for (const cmd of commands) {
        // Skip commands that are just comments or empty
        if (!cmd || cmd.startsWith("#")) continue;

        const result = await bash.exec(cmd);

        // Commands should not have stderr (warnings/errors)
        // Allow exitCode 1 for grep (no matches) but fail on other errors
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          expect.fail(
            `Bash command failed in AGENTS.npm.md:\n` +
              `Command: ${cmd}\n` +
              `Exit code: ${result.exitCode}\n` +
              `Stderr: ${result.stderr}`,
          );
        }
      }
    }
  });
});
