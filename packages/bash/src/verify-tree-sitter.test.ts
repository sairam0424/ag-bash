import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(__dirname, "..");
const webTreeSitterWasm = fs.readFileSync(
  path.join(pkgRoot, "vendor", "web-tree-sitter.wasm"),
);
const bashGrammarWasm = fs.readFileSync(
  path.join(pkgRoot, "vendor", "tree-sitter-bash.wasm"),
);

describe("v2.9 Tree-sitter Parser Integration", () => {
  let bash: Bash;

  beforeAll(async () => {
    bash = new Bash({
      parser: {
        engine: "tree-sitter",
        treeSitterConfig: {
          webTreeSitterWasm,
          bashGrammarWasm,
        },
      },
    });
  });

  it("should execute basic echo command", async () => {
    const result = await bash.exec(
      'echo "v2.9 tree-sitter integration successful"',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      "v2.9 tree-sitter integration successful",
    );
  });

  it("should handle if statements", async () => {
    const result = await bash.exec(
      'if [ 1 -eq 1 ]; then echo "logic works"; fi',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("logic works");
  });

  it("should handle complex word expansions", async () => {
    const result = await bash.exec('FOO=bar; echo "val is ${FOO}"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("val is bar");
  });
});
