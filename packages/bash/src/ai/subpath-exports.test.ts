/**
 * Contract tests for the documented `@ag-bash/bash/ai` subpath export.
 *
 * `packages/bash/package.json` maps `./ai` to TWO DIFFERENT MODULES:
 *
 *   "./ai": {
 *     "import":  { "types": "./dist/ai/index.d.ts",  "default": "./dist/ai.js"  },
 *     "require": { "types": "./dist/ai/index.d.cts", "default": "./dist/ai.cjs" }
 *   }
 *
 * The published *types* are emitted from `src/ai/index.ts`. The published
 * *runtime* is emitted from `src/ai.ts` (`dist/ai.cjs` is just an esbuild
 * bundle of `dist/ai.js`; `dist/ai/index.d.cts` is a `cp` of
 * `dist/ai/index.d.ts` — see the `build` script). Nothing in the build or in
 * the type system links those two files, so they drift silently: a consumer
 * gets a TypeScript-clean import that is an ESM link error / `undefined` under
 * CJS, or a value whose declared methods do not exist at runtime.
 *
 * README.md documents `@ag-bash/bash/ai` as "Multi-framework adapters (OpenAI,
 * Anthropic, LangChain, Vercel)", so the DECLARATIONS are the intended
 * contract and the runtime module is the side that must satisfy them.
 *
 * These tests import both sides the way the export map wires them and pin the
 * invariant that makes the subpath honest.
 */

import { describe, expect, it } from "vitest";
import * as aiSubpathRuntime from "../ai.js";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import * as aiSubpathDeclarations from "./index.js";

/**
 * Every value export the `./ai` type declarations promise. Pinned explicitly so
 * this suite can never pass vacuously: if `src/ai/index.ts` gained or lost a
 * value export, the first test fails and whoever changed it has to decide
 * whether `src/ai.ts` (the runtime half of `./ai`) must follow.
 */
const DECLARED_VALUE_EXPORTS = [
  "createBashTool",
  "toAnthropic",
  "toLangChain",
  "toOpenAI",
  "toVercel",
] as const;

function newSandbox(files?: Record<string, string>): Bash {
  return files === undefined
    ? new Bash({ fs: new InMemoryFs() })
    : new Bash({ files });
}

describe("./ai export map: declarations vs runtime", () => {
  it("declares exactly the value exports this suite pins", () => {
    expect(Object.keys(aiSubpathDeclarations).sort()).toEqual([
      ...DECLARED_VALUE_EXPORTS,
    ]);
  });

  it("exposes every declared value export from the ./ai runtime module", () => {
    const declared = new Map(Object.entries(aiSubpathDeclarations));
    const runtime = new Map(Object.entries(aiSubpathRuntime));

    const missing = [...declared.keys()].filter((name) => !runtime.has(name));
    expect(
      missing,
      "dist/ai/index.d.ts declares these, but dist/ai.js does not export them",
    ).toEqual([]);

    for (const [name, declaredValue] of declared) {
      expect(typeof runtime.get(name), `./ai runtime export "${name}"`).toBe(
        typeof declaredValue,
      );
    }
  });
});

describe("createBashTool() from the ./ai runtime", () => {
  it("returns the BashToolBuilder its declared type promises", () => {
    const builder = aiSubpathRuntime.createBashTool({ sandbox: newSandbox() });

    for (const method of [
      "forVercel",
      "forOpenAI",
      "forAnthropic",
      "forLangChain",
      "generic",
    ] as const) {
      expect(typeof builder[method], `builder.${method}()`).toBe("function");
    }
  });

  it("builds a working Vercel AI SDK tool set", async () => {
    const builder = aiSubpathRuntime.createBashTool({
      sandbox: newSandbox({ "/greet.txt": "hello-vercel\n" }),
    });

    const { tools } = builder.forVercel();
    expect(tools.bash).toBeDefined();

    const result = await tools.bash.execute({ command: "cat /greet.txt" });
    expect(result).toMatchObject({ exitCode: 0 });
    expect(JSON.stringify(result)).toContain("hello-vercel");
  });

  it("builds a working OpenAI function-calling tool set", async () => {
    const builder = aiSubpathRuntime.createBashTool({
      sandbox: newSandbox({ "/greet.txt": "hello-openai\n" }),
    });

    const { tools, handleToolCall } = builder.forOpenAI();
    const bashTool = tools.find((entry) => entry.function.name === "bash");
    expect(bashTool?.type).toBe("function");
    expect(bashTool?.function.parameters.properties?.command).toBeDefined();

    const raw = await handleToolCall(
      "bash",
      JSON.stringify({ command: "cat /greet.txt" }),
    );
    expect(raw).toContain("hello-openai");
    expect(raw).toContain('"exitCode":0');
  });

  it("builds a working Anthropic tool_use tool set", async () => {
    const builder = aiSubpathRuntime.createBashTool({
      sandbox: newSandbox({ "/greet.txt": "hello-anthropic\n" }),
    });

    const { tools, handleToolUse } = builder.forAnthropic();
    expect(tools.map((entry) => entry.name)).toContain("bash");

    const { content } = await handleToolUse("bash", {
      command: "cat /greet.txt",
    });
    expect(content).toContain("hello-anthropic");
  });

  it("builds a working LangChain tool set", async () => {
    const builder = aiSubpathRuntime.createBashTool({
      sandbox: newSandbox({ "/greet.txt": "hello-langchain\n" }),
    });

    const { tools } = builder.forLangChain();
    const bashTool = tools.find((entry) => entry.name === "bash");
    expect(bashTool).toBeDefined();
    expect(bashTool?.schema._def.typeName).toBe("ZodObject");

    const output = await bashTool?.func({ command: "cat /greet.txt" });
    expect(output).toContain("hello-langchain");
  });

  it("builds a working framework-agnostic generic tool set", async () => {
    const builder = aiSubpathRuntime.createBashTool({
      sandbox: newSandbox({ "/greet.txt": "hello-generic\n" }),
    });

    const generic = builder.generic();
    expect(generic.tools.map((def) => def.name)).toContain("bash");

    const result = await generic.handleCall("bash", {
      command: "cat /greet.txt",
    });
    expect(JSON.stringify(result)).toContain("hello-generic");
  });
});

describe("adapter functions re-exported from the ./ai runtime", () => {
  it("accept the generic tool definitions the builder produces", async () => {
    const definitions = aiSubpathRuntime
      .createBashTool({
        sandbox: newSandbox({ "/greet.txt": "hello-adapters\n" }),
      })
      .generic().tools;

    const vercel = aiSubpathRuntime.toVercel(definitions);
    expect(vercel.tools.bash).toBeDefined();

    const openai = aiSubpathRuntime.toOpenAI(definitions);
    expect(
      await openai.handleToolCall("bash", '{"command":"cat /greet.txt"}'),
    ).toContain("hello-adapters");

    const anthropic = aiSubpathRuntime.toAnthropic(definitions);
    expect(
      (await anthropic.handleToolUse("bash", { command: "cat /greet.txt" }))
        .content,
    ).toContain("hello-adapters");

    const langchain = aiSubpathRuntime.toLangChain(definitions);
    expect(langchain.tools.map((entry) => entry.name)).toContain("bash");
  });
});

describe("./ai backwards compatibility", () => {
  it("keeps the README's `const { tools } = createBashTool(...)` shape working", async () => {
    const { tools } = aiSubpathRuntime.createBashTool({
      sandbox: newSandbox({ "/data.json": '{"ok":true}' }),
    });

    const result = await tools.bash.execute({ command: "cat /data.json" });
    expect(JSON.stringify(result)).toContain('{\\"ok\\":true}');
  });

  it("still accepts the deprecated `destination` option", async () => {
    const { tools } = aiSubpathRuntime.createBashTool({
      sandbox: newSandbox({ "/workspace/a.txt": "legacy-ok\n" }),
      destination: "/workspace",
    });

    const result = await tools.bash.execute({
      command: "cat /workspace/a.txt",
    });
    expect(JSON.stringify(result)).toContain("legacy-ok");
  });

  it("forwards extraInstructions into every framework's bash description", () => {
    const builder = aiSubpathRuntime.createBashTool({
      sandbox: newSandbox(),
      extraInstructions: "SENTINEL-INSTRUCTION",
    });

    expect(builder.forVercel().tools.bash.description).toContain(
      "SENTINEL-INSTRUCTION",
    );
    expect(
      builder.forAnthropic().tools.find((t) => t.name === "bash")?.description,
    ).toContain("SENTINEL-INSTRUCTION");
    expect(
      builder.forOpenAI().tools.find((t) => t.function.name === "bash")
        ?.function.description,
    ).toContain("SENTINEL-INSTRUCTION");
  });
});
