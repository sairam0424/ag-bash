# ag_browser_* MCP Tool Suite (browser-harness-backed) Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a curated `ag_browser_*` toolbox/MCP tool suite to Ag-Bash that performs scripted, deterministic Chrome DevTools Protocol automation (navigate, click, type, screenshot, evaluate JS, raw CDP, wait-for-element, page-info) by delegating to the `browser-harness-mcp` server — explicitly a scripted-automation surface, not an autonomous `browser_use.Agent` integration.

**Architecture:** A new optional workspace package `@ag-bash/browser` depends on `@ag-bash/bash` and defines nine `ToolboxTool` objects (built via the now-exported `buildTool` helper) whose `execute()` lazily spawns and talks to `browser-harness-mcp` through the *existing* `bash.services.mcpClient` (`McpClient`/`connectStdio`/`callTool`) already shipped in `@ag-bash/bash` — no new npm dependency, no new native addon, and zero code changes to the core package's sandbox. `@ag-bash/mcp-server` optionally `import()`s `@ag-bash/browser` at startup (try/catch, exactly mirroring the existing `@mongodb-js/zstd`/`node-liblzma` optional-native-dep pattern in `packages/bash/src/commands/tar/archive.ts`) and calls its `registerBrowserTools(bash)` export; once registered on `bash.toolbox`, the tools are automatically surfaced over MCP by the pre-existing `McpToolBridge` with **no mcp-server protocol code to write**. A latent, previously-unexercised protocol bug in `McpClient` (wrong JSON-RPC method names, no `initialize` handshake) must be fixed first, or this feature will not actually work against a real MCP server like `browser-harness-mcp`.

**Tech Stack:** TypeScript (Node 22, pnpm workspace, `"type": "module"`), Zod v4 (`^4.3.6`) for tool parameter schemas, Vitest 4 for tests, the existing `McpClient` stdio JSON-RPC transport (`node:child_process`), `browser-harness-mcp` (external, ambient `uvx`-launched Python MCP server — installed via `uv tool install browser-harness[mcp]`, already registered on this host as `{"type":"stdio","command":"uvx","args":["--from","browser-harness[mcp]","browser-harness-mcp"]}`).

**Spec:** This plan supersedes the prior portfolio research brief, which assumed (a) the browser integration would shell out to the bare `browser-harness` CLI with a Python heredoc on stdin, and (b) a fresh optionalDependencies/native-addon pattern would be needed for `@ag-bash/browser`. Live verification against the actual repo and the actual installed tools shows neither is true: `browser-harness-mcp` (a *separate* binary from the bare `browser-harness` CLI, installed by the same `browser-harness[mcp]` extra) speaks real MCP JSON-RPC over stdio directly, and Ag-Bash's core package already has a generic, publicly-reachable stdio-MCP-client primitive (`bash.services.mcpClient` / `ag-mcp connect stdio`) built for exactly this. The only missing pieces are: (1) that primitive has a real, verified protocol bug that prevents it from talking to *any* spec-compliant third-party server, (2) `buildTool`/`ToolboxTool` — needed to author new tools — were never exported from the package's public surface, and (3) the actual curated `ag_browser_*` tool suite + optional wiring into the MCP server.

## Global Constraints

- Core package (`@ag-bash/bash`) sandbox purity rule: "No Node.js native dependencies allowed in the core package (except optional WASM runtimes)" (`CLAUDE.md` line 101; `packages/bash/README.md` line 155 "Zero native deps"). This plan adds **zero** new npm dependencies and **zero** new native addons to `@ag-bash/bash` — it only fixes an existing bug in `packages/bash/src/services/McpClient.ts` and adds two exports to `packages/bash/src/index.ts`.
- The optional-native-dependency pattern to mirror (per `packages/bash/src/commands/tar/archive.ts` lines 22-64): lazy `await import(...)` wrapped in try/catch, with a memoized load-error so repeated calls fail fast with a clear message. This plan applies the *same shape* at package granularity: `@ag-bash/mcp-server` optionally imports the whole `@ag-bash/browser` package instead of a single native module.
- Resource budgeting precedent to mirror (per `packages/bash/src/limits.ts` defaults): `maxMcpServers: 5`, `maxMcpToolCalls: 50` (both actively enforced today in `McpClient.connectStdio`/`callTool`), and `StdioTransportOptions.requestTimeoutMs` (default `30_000`ms, actively enforced via a `setTimeout`+reject race in `StdioTransport.send()`). `ensureBrowserHarnessConnection` uses `requestTimeoutMs: 60_000` for the browser-harness connection specifically, because navigation/screenshot actions routinely exceed the 30s default sized for quick tool calls.
- Monorepo version is fixed-mode synchronized at `6.0.4` across `packages/bash`, `packages/mcp-server`, `packages/agent-bridge` (`scripts/check-version-sync.js`). `@ag-bash/browser` starts at the same `6.0.4` for consistency but is **not** added to `check-version-sync.js`'s `PACKAGES` array in this plan (out of scope — that gate is for the three already-publishing packages; extending it is a separate, later decision the human can make once this package has shipped once).
- Toolbox convention (per `packages/bash/src/commands/ag-web/ag-web-fetch.ts`, `EditTool.ts`): build tools with `buildTool()`, set `isReadOnly`/`isDestructive` literals (not functions, so `McpToolBridge.listTools()` can resolve real annotations instead of the conservative unresolved defaults), and **omit** `checkPermissions` for destructive tools so `buildTool`'s default plan-mode gate applies (`Cannot execute destructive tool '<name>' in plan mode.`).
- Lint/type gates that apply to every touched file in `packages/bash`, `packages/mcp-server`: `pnpm --filter <pkg> lint` (Biome + `scripts/check-banned-patterns.js`, which bans bare `{}` object literals — use `Object.create(null)` or `// @banned-pattern-ignore: <reason>`), `pnpm --filter <pkg> typecheck` (`tsc --noEmit`, strict).

---

### Task 1: Fix `McpClient` MCP protocol compliance (initialize handshake, real method names)

**Files:**
- Modify: `packages/bash/src/services/McpClient.ts` (imports lines 5-8; `McpTransport` interface lines 46-50; `HttpTransport` lines 148-177; `StdioTransport` lines 185-284; `McpClient` class lines 286-422 — `connectStdio` ~289-318, `connectHttp` ~320-347, `discoverTools` ~349-361, `callTool` ~363-401)
- Create: `packages/bash/src/services/__fixtures__/fake-mcp-server.mjs`
- Create: `packages/bash/src/services/McpClient.test.ts`

**Interfaces:** Consumes: nothing from earlier tasks (this is the first task). Produces: `McpTransport.notify(message: unknown): void` (new interface member, implemented by both `HttpTransport` and `StdioTransport`); `McpClient` now performs a correct `initialize` → `notifications/initialized` → `tools/list`/`tools/call` handshake, which Task 3's `ensureBrowserHarnessConnection` depends on to actually talk to `browser-harness-mcp`.

**Verified bug (real repro, captured live against the pristine file before any fix):**

Running the "before" version of the test below against the pristine `McpClient.ts` produces:
```
AssertionError: expected [] to deeply equal [ 'echo' ]
...
Error: Method not found: call_tool
```
This is because `McpClient.ts` currently sends non-spec method names (`list_tools`, `call_tool` instead of `tools/list`, `tools/call`) and never performs the MCP `initialize` handshake before them. No existing test in the repo ever spawns a real MCP server against this client (`grep -rl "mcpClient\|McpClient" src --include="*.test.ts"` finds `ServiceContainer.test.ts`, which spies on `dispose()`, and `nexus-prime-integration.test.ts`, which fully replaces `McpClient` via `vi.mock` with a no-op stub exposing `connectStdio`/`connectHttp`/`listConnections`/`disconnect`/`callTool` — the stdio round-trip has zero coverage today), so this bug is real and latent.

- [ ] Write the failing test. Create `packages/bash/src/services/__fixtures__/fake-mcp-server.mjs`:
  ```js
  #!/usr/bin/env node
  /**
   * Minimal spec-correct MCP stdio server, used ONLY by McpClient.test.ts to
   * verify the real client speaks the real MCP handshake + tools/list +
   * tools/call methods, without spawning a live browser or network service.
   *
   * Gates tools/list and tools/call on having seen "initialize" first,
   * mirroring a real MCP server (e.g. browser-harness-mcp) so the test can
   * assert on handshake ordering, not just method-name spelling.
   */
  import { createInterface } from "node:readline";

  const rl = createInterface({ input: process.stdin });
  let initialized = false;

  const TOOLS = [
    {
      name: "echo",
      description: "Echoes back its input",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ];

  function respond(id, result) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  function respondError(id, code, message) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
    );
  }

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = msg;

    if (method === "initialize") {
      initialized = true;
      respond(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        // @banned-pattern-ignore: static keys only, never accessed with user input
        capabilities: {},
        serverInfo: { name: "fake-mcp-server", version: "0.0.0" },
      });
      return;
    }
    if (method === "notifications/initialized") {
      // Notification: no response expected, and none is sent.
      return;
    }
    if (method === "tools/list") {
      if (!initialized) {
        respondError(id, -32002, "Server not initialized");
        return;
      }
      respond(id, { tools: TOOLS });
      return;
    }
    if (method === "tools/call") {
      if (!initialized) {
        respondError(id, -32002, "Server not initialized");
        return;
      }
      if (params?.name === "echo") {
        respond(id, {
          content: [{ type: "text", text: String(params?.arguments?.text ?? "") }],
        });
        return;
      }
      respondError(id, -32601, `Unknown tool: ${params?.name}`);
      return;
    }
    respondError(id, -32601, `Method not found: ${method}`);
  });
  ```

  Create `packages/bash/src/services/McpClient.test.ts`:
  ```ts
  import { dirname, resolve } from "node:path";
  import { fileURLToPath } from "node:url";
  import { describe, expect, it } from "vitest";
  import { Bash } from "../Bash.js";
  import type { CommandContext } from "../types.js";
  import { McpClient } from "./McpClient.js";

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const FIXTURE_SERVER = resolve(__dirname, "__fixtures__/fake-mcp-server.mjs");

  /**
   * connectStdio() only reads `cmdCtx.bash`; the rest of CommandContext (fs,
   * cwd, env, stdin) is irrelevant to spawning an MCP server, so a minimal
   * synthetic context is used rather than fabricating a full shell context.
   */
  function fakeCommandContext(bash: Bash): CommandContext {
    return { bash } as unknown as CommandContext;
  }

  describe("McpClient stdio protocol compliance", () => {
    it("performs the initialize handshake before discovering tools", async () => {
      const bash = new Bash();
      const client = new McpClient();
      const conn = await client.connectStdio(
        "fake",
        "node",
        [FIXTURE_SERVER],
        fakeCommandContext(bash),
      );
      expect(conn.status).toBe("connected");
      expect(conn.tools.map((t) => t.name)).toEqual(["echo"]);
      client.disconnect("fake");
    });

    it("calls tools via the spec-correct tools/call method", async () => {
      const bash = new Bash();
      const client = new McpClient();
      await client.connectStdio(
        "fake",
        "node",
        [FIXTURE_SERVER],
        fakeCommandContext(bash),
      );
      const result = await client.callTool("fake", "echo", { text: "hello" }, bash);
      expect(result).toEqual({ content: [{ type: "text", text: "hello" }] });
      client.disconnect("fake");
    });
  });
  ```

- [ ] Run it and confirm it fails. Command: `pnpm --filter @ag-bash/bash test run src/services/McpClient.test.ts`. Expected failure (verified live against the pristine file): the first test fails with `AssertionError: expected [] to deeply equal [ 'echo' ]`; the second fails with `Error: Method not found: call_tool` thrown from `McpClient.callTool`.

- [ ] Write the minimal implementation. In `packages/bash/src/services/McpClient.ts`:

  1. Add the `VERSION` import (after line 8):
     ```ts
     import { VERSION } from "../version.js";
     ```

  2. Add `notify` to the `McpTransport` interface (replace lines 46-50):
     ```ts
     export interface McpTransport {
       init(): Promise<void>;
       send(message: unknown): Promise<unknown>;
       /**
        * Send a JSON-RPC notification (no `id`, no response expected). Separate
        * from {@link send} because notifications must never be registered in a
        * pending-request map: a server that legitimately never replies to
        * `notifications/initialized` would otherwise hang that call until its
        * request-timeout fires.
        */
       notify(message: unknown): void;
       close(): void;
     }
     ```

  3. Add `HttpTransport.notify` (insert before its `close(): void {}` at line 176):
     ```ts
       notify(message: unknown): void {
         // HTTP has no persistent pending-request map to leak: a POST whose
         // response is discarded is a safe fire-and-forget notification frame.
         void this.send(message).catch(() => {});
       }

     ```

  4. Add `StdioTransport.notify` (insert before its `close(): void {` at line 269):
     ```ts
       notify(message: unknown): void {
         if (!this.process) return;
         // Deliberately omits `id`: this is what makes it a JSON-RPC
         // notification rather than a request. `send()` always assigns one,
         // which is why a notification cannot be sent through it without
         // hanging.
         const envelope = Object.assign(Object.create(null), message as object, {
           jsonrpc: "2.0",
         });
         this.process.stdin?.write(`${JSON.stringify(envelope)}\n`);
       }

     ```

  5. Add a `handshake` helper and call it from both connect methods. Replace the start of the `McpClient` class (from `export class McpClient {` through the end of `connectStdio`'s `await transport.init();` line) with:
     ```ts
     export class McpClient {
       private connections: Map<string, McpServerConnection> = new Map();

       /** MCP protocol revision this client requests during `initialize`. */
       private static readonly PROTOCOL_VERSION = "2025-06-18";

       /**
        * Perform the MCP `initialize` request followed by the
        * `notifications/initialized` notice. The spec requires this exchange
        * before any `tools/list` or `tools/call` request is legal; a real
        * server (unlike the untested mock transports this client was
        * previously only exercised against) rejects those requests otherwise.
        */
       private async handshake(transport: McpTransport): Promise<void> {
         await transport.send({
           method: "initialize",
           params: {
             protocolVersion: McpClient.PROTOCOL_VERSION,
             capabilities: Object.create(null),
             clientInfo: { name: "ag-bash", version: VERSION },
           },
         });
         transport.notify({
           method: "notifications/initialized",
           params: Object.create(null),
         });
       }

       async connectStdio(
         id: string,
         command: string,
         args: string[],
         cmdCtx: CommandContext,
         options?: StdioTransportOptions,
       ): Promise<McpServerConnection> {
         const bash = cmdCtx.bash;
         if (bash && this.connections.size >= bash.limits.maxMcpServers) {
           throw new Error(
             `Maximum MCP servers reached (${bash.limits.maxMcpServers})`,
           );
         }

         const transport = new StdioTransport(command, args, options);
         await transport.init();
         await this.handshake(transport);
     ```
     (the remainder of `connectStdio` — building and storing `connection`, calling `discoverTools(id)`, `return connection;` — is unchanged.)

  6. In `connectHttp`, insert `await this.handshake(transport);` immediately after its own `await transport.init();` line (unchanged otherwise).

  7. In `discoverTools`, change the method name (the only change):
     ```ts
       const response = (await conn.transport.send({
         method: "tools/list",
         params: Object.create(null),
       })) as JsonRpcResponse;
     ```

  8. In `callTool`, change the method name (the only change):
     ```ts
       const response = (await conn.transport.send({
         method: "tools/call",
         params: { name: toolName, arguments: args },
       })) as JsonRpcResponse;
     ```

- [ ] Run it and confirm it passes. Command: `pnpm --filter @ag-bash/bash test run src/services/McpClient.test.ts` — expect `Test Files 1 passed (1)`, `Tests 2 passed (2)` (verified live). Also run `pnpm --filter @ag-bash/bash typecheck` (expect clean, no output) and `pnpm --filter @ag-bash/bash lint` scoped check via `npx biome check src/services/McpClient.ts src/services/__fixtures__/fake-mcp-server.mjs` and `node ../../scripts/check-banned-patterns.js` (both verified clean live, the fixture's `capabilities: {}` needs the `// @banned-pattern-ignore` comment shown above or `check-banned-patterns.js` flags it).

- [ ] Commit.
  ```bash
  git add packages/bash/src/services/McpClient.ts packages/bash/src/services/McpClient.test.ts packages/bash/src/services/__fixtures__/fake-mcp-server.mjs
  git commit -m "fix(mcp-client): speak real MCP JSON-RPC (initialize handshake, tools/list, tools/call)"
  ```

---

### Task 2: Export `buildTool`/`ToolboxTool` from `@ag-bash/bash`'s public surface

**Files:**
- Modify: `packages/bash/src/index.ts` (insert after line 4)
- Create: `packages/bash/src/public-exports.test.ts`

**Interfaces:** Consumes: nothing new. Produces: `@ag-bash/bash` now exports `buildTool` (function) and `ToolboxTool`/`ToolMetadata` (types) at its top-level `"."` entry point — this is what Task 3/4 in the new `@ag-bash/browser` package import to author tools the same way `packages/bash/src/commands/ag-web/ag-web-fetch.ts` does internally.

- [ ] Write the failing test. Create `packages/bash/src/public-exports.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { z } from "zod";
  import { Bash, buildTool, type ToolboxTool } from "./index.js";

  describe("public exports: agentic tool authoring surface", () => {
    it("exposes buildTool for downstream packages (e.g. @ag-bash/browser) to author ToolboxTool-conformant tools", async () => {
      expect(typeof buildTool).toBe("function");

      const tool: ToolboxTool<{ value: string }, string> = buildTool({
        name: "test_echo_tool",
        description: "Echoes its input",
        parameters: z.object({ value: z.string() }),
        execute: async (_bash: Bash, args) => args.value,
      });

      expect(tool.name).toBe("test_echo_tool");
      const bash = new Bash();
      expect(await tool.execute(bash, { value: "hi" })).toBe("hi");
    });
  });
  ```

- [ ] Run it and confirm it fails. Command: `pnpm --filter @ag-bash/bash test run src/public-exports.test.ts`. Expected failure (verified live against the pristine file): `AssertionError: expected 'undefined' to be 'function'` at the `expect(typeof buildTool).toBe("function")` line (the named import resolves to `undefined` rather than throwing, per this repo's Vite/esbuild ESM transform).

- [ ] Write the minimal implementation. In `packages/bash/src/index.ts`, insert after line 4 (`export { ToolSearchEngine } from "./agentic/ToolSearchEngine.js";`):
  ```ts
  export { buildTool, type ToolboxTool, type ToolMetadata } from "./agentic/Tool.js";
  ```
  Then run `npx biome check --write src/index.ts` from `packages/bash/` — Biome's `organizeImports` sorts this line before the `ToolSearchEngine.js` exports (alphabetical: `Tool.js` < `ToolSearchEngine.js`) and wraps it to multi-line (verified live, exact resulting diff):
  ```ts
  // AST types (for plugin authors)

  export { buildTool, type ToolboxTool, type ToolMetadata } from "./agentic/Tool.js";
  export type { SearchResult } from "./agentic/ToolSearchEngine.js";
  export { ToolSearchEngine } from "./agentic/ToolSearchEngine.js";
  // AI Tool integration
  ...
  ```
  (Biome reflows the `export { buildTool, ... }` line onto 5 lines because it exceeds the print width — let the formatter do this rather than hand-wrapping; running `biome check --write` is the authoritative step.)

- [ ] Run it and confirm it passes. Command: `pnpm --filter @ag-bash/bash test run src/public-exports.test.ts` — expect `Test Files 1 passed (1)`, `Tests 1 passed (1)` (verified live). Also `pnpm --filter @ag-bash/bash typecheck` (clean) and `npx biome check src/index.ts` from `packages/bash/` (expect `Checked 1 file... No fixes applied.`, verified live) and `npx knip --config ../../knip.json` from `packages/bash/` (expect no output / zero unused-export findings, verified live).

- [ ] Commit.
  ```bash
  git add packages/bash/src/index.ts packages/bash/src/public-exports.test.ts
  git commit -m "feat(bash): export buildTool/ToolboxTool for downstream tool-authoring packages"
  ```

---

### Task 3: Scaffold `@ag-bash/browser` package + lazy browser-harness connection helper

**Files:**
- Create: `packages/browser/package.json`
- Create: `packages/browser/tsconfig.json`
- Create: `packages/browser/vitest.config.ts`
- Create: `packages/browser/src/connection.ts`
- Create: `packages/browser/src/connection.test.ts`

**Interfaces:** Consumes: `Bash`, `CommandContext` (both already exported from `@ag-bash/bash`'s `"."` entry per `packages/bash/src/index.ts` line ~192-198 — verified already present, no Task-2 change needed for `CommandContext`). Produces: `BROWSER_HARNESS_CONNECTION_ID: string` and `ensureBrowserHarnessConnection(bash: Bash): Promise<void>`, which Task 4's tool `execute()` functions call before every `mcpClient.callTool(...)`.

- [ ] Write the failing test. Create `packages/browser/package.json`:
  ```json
  {
    "name": "@ag-bash/browser",
    "version": "6.0.4",
    "description": "Optional ag_browser_* MCP tool suite for Ag-Bash — scripted, deterministic Chrome DevTools Protocol automation (navigate, click, type, screenshot, evaluate JS, raw CDP) backed by browser-harness-mcp. Not an autonomous browser-use.Agent integration.",
    "type": "module",
    "main": "dist/index.js",
    "module": "dist/index.js",
    "types": "dist/index.d.ts",
    "files": [
      "dist/",
      "README.md"
    ],
    "exports": {
      ".": {
        "import": {
          "types": "./dist/index.d.ts",
          "default": "./dist/index.js"
        }
      }
    },
    "scripts": {
      "build": "rm -rf dist && tsc && find dist -name '*.test.js' -delete && find dist -name '*.test.d.ts' -delete && find dist -name '*.test.js.map' -delete",
      "lint": "biome check . && pnpm lint:banned",
      "lint:banned": "node ../../scripts/check-banned-patterns.js",
      "typecheck": "tsc --noEmit",
      "test": "vitest run",
      "test:watch": "vitest"
    },
    "keywords": [
      "ag-bash",
      "agentic",
      "browser",
      "cdp",
      "mcp"
    ],
    "homepage": "https://github.com/sairam0424/ag-bash/tree/main/packages/browser#readme",
    "bugs": {
      "url": "https://github.com/sairam0424/ag-bash/issues"
    },
    "repository": {
      "type": "git",
      "url": "https://github.com/sairam0424/ag-bash.git",
      "directory": "packages/browser"
    },
    "author": "Ag-Bash",
    "license": "Apache-2.0",
    "dependencies": {
      "@ag-bash/bash": "workspace:*",
      "zod": "^4.3.6"
    },
    "devDependencies": {
      "typescript": "^5.9.3",
      "vitest": "^4.0.16"
    },
    "engines": {
      "node": ">=20.6.0"
    },
    "publishConfig": {
      "access": "public"
    }
  }
  ```

  Create `packages/browser/tsconfig.json` (mirrors `packages/agent-bridge/tsconfig.json`, minus its `"DOM"` lib entry since this package never touches DOM globals — verified live that this shape typechecks and emits a flat `dist/index.d.ts`/`dist/index.js` with no `rootDir` conflicts, since it deliberately does NOT path-alias `@ag-bash/bash` to source — production builds resolve it normally through the workspace-linked `node_modules/@ag-bash/bash` -> `packages/bash/dist`):
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "lib": ["ESNext"],
      "declaration": true,
      "sourceMap": true,
      "rootDir": "src",
      "outDir": "dist",
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "forceConsistentCasingInFileNames": true,
      "resolveJsonModule": true,
      "baseUrl": "."
    },
    "include": ["src"],
    "exclude": ["node_modules", "dist"]
  }
  ```

  Create `packages/browser/vitest.config.ts` (mirrors `packages/mcp-server/vitest.config.ts`'s alias so tests run against `@ag-bash/bash`'s current SOURCE, not a possibly-stale built `dist/` — verified live that this resolves and runs):
  ```ts
  import { dirname, resolve } from "node:path";
  import { fileURLToPath } from "node:url";
  import { defineConfig } from "vitest/config";

  const __dirname = dirname(fileURLToPath(import.meta.url));

  /**
   * Resolves `@ag-bash/bash` to the workspace SOURCE (not the built dist
   * bundle) so tests exercise the current engine — mirrors
   * packages/mcp-server/vitest.config.ts's rationale for the same alias.
   */
  export default defineConfig({
    test: {
      globals: true,
      testTimeout: 30000,
      hookTimeout: 30000,
    },
    resolve: {
      alias: {
        "@ag-bash/bash": resolve(__dirname, "../bash/src/index.ts"),
      },
    },
  });
  ```

  Create `packages/browser/src/connection.test.ts`:
  ```ts
  import { Bash } from "@ag-bash/bash";
  import { describe, expect, it, vi } from "vitest";
  import {
    BROWSER_HARNESS_CONNECTION_ID,
    ensureBrowserHarnessConnection,
  } from "./connection.js";

  function fakeConnection() {
    return {
      id: BROWSER_HARNESS_CONNECTION_ID,
      name: BROWSER_HARNESS_CONNECTION_ID,
      type: "stdio" as const,
      status: "connected" as const,
      tools: [],
      transport: { init: vi.fn(), send: vi.fn(), notify: vi.fn(), close: vi.fn() },
    };
  }

  describe("ensureBrowserHarnessConnection", () => {
    it("connects with the documented browser-harness-mcp stdio invocation", async () => {
      const bash = new Bash();
      vi.spyOn(bash.services.mcpClient, "listConnections").mockReturnValue([]);
      const connectStdio = vi
        .spyOn(bash.services.mcpClient, "connectStdio")
        .mockResolvedValue(fakeConnection());

      await ensureBrowserHarnessConnection(bash);

      expect(connectStdio).toHaveBeenCalledWith(
        "browser-harness",
        "uvx",
        ["--from", "browser-harness[mcp]", "browser-harness-mcp"],
        expect.objectContaining({ bash }),
        { requestTimeoutMs: 60_000 },
      );
    });

    it("reuses an existing connection instead of reconnecting", async () => {
      const bash = new Bash();
      vi.spyOn(bash.services.mcpClient, "listConnections").mockReturnValue([
        fakeConnection(),
      ]);
      const connectStdio = vi.spyOn(bash.services.mcpClient, "connectStdio");

      await ensureBrowserHarnessConnection(bash);

      expect(connectStdio).not.toHaveBeenCalled();
    });

    it("shares one in-flight connection across concurrent callers", async () => {
      const bash = new Bash();
      vi.spyOn(bash.services.mcpClient, "listConnections").mockReturnValue([]);
      let resolveConnect: (value: ReturnType<typeof fakeConnection>) => void = () => {};
      const connectStdio = vi
        .spyOn(bash.services.mcpClient, "connectStdio")
        .mockReturnValue(
          new Promise((resolve) => {
            resolveConnect = resolve;
          }),
        );

      const first = ensureBrowserHarnessConnection(bash);
      const second = ensureBrowserHarnessConnection(bash);
      resolveConnect(fakeConnection());
      await Promise.all([first, second]);

      expect(connectStdio).toHaveBeenCalledTimes(1);
    });
  });
  ```

- [ ] Run it and confirm it fails. Commands:
  ```bash
  pnpm install --no-frozen-lockfile
  pnpm --filter @ag-bash/browser test
  ```
  Expected failure: `Error: Cannot find module './connection.js' imported from .../packages/browser/src/connection.test.ts` (exact format verified live against this repo's Vite/esbuild-transformed Vitest setup) — `connection.ts` does not exist yet.

- [ ] Write the minimal implementation. Create `packages/browser/src/connection.ts`:
  ```ts
  import type { Bash, CommandContext } from "@ag-bash/bash";

  /**
   * Connection id used for the browser-harness MCP server on a Bash
   * instance's `mcpClient`, matching the id this host's own MCP-server
   * registration (`~/.claude.json` `mcpServers.browser-harness`) uses for the
   * identical stdio invocation.
   */
  export const BROWSER_HARNESS_CONNECTION_ID = "browser-harness";

  /**
   * In-flight (or completed) connect promises, keyed by Bash instance, so
   * concurrent ag_browser_* calls on the same shell share one connection
   * attempt instead of racing to spawn duplicate browser-harness-mcp
   * processes.
   */
  const connecting = new WeakMap<Bash, Promise<void>>();

  /**
   * Lazily connect the given Bash instance's MCP client to the
   * browser-harness MCP server: `uvx --from "browser-harness[mcp]"
   * browser-harness-mcp` — the exact stdio invocation browser-harness
   * documents (and this host already registers) for MCP clients. Idempotent:
   * a call while a connection exists (or is in flight) reuses it instead of
   * spawning a second process.
   *
   * Uses a 60s per-call timeout (vs. McpClient's 30s default): browser
   * navigation and screenshot actions routinely exceed the default, which is
   * sized for quick tool calls, not page loads.
   */
  export async function ensureBrowserHarnessConnection(
    bash: Bash,
  ): Promise<void> {
    const already = bash.services.mcpClient
      .listConnections()
      .some((connection) => connection.id === BROWSER_HARNESS_CONNECTION_ID);
    if (already) return;

    let pending = connecting.get(bash);
    if (!pending) {
      // connectStdio only reads `cmdCtx.bash`; the rest of CommandContext
      // (fs, cwd, env, stdin) is irrelevant to spawning an MCP server, so a
      // minimal synthetic context is used rather than fabricating a full
      // shell context.
      const cmdCtx = { bash } as unknown as CommandContext;
      pending = bash.services.mcpClient
        .connectStdio(
          BROWSER_HARNESS_CONNECTION_ID,
          "uvx",
          ["--from", "browser-harness[mcp]", "browser-harness-mcp"],
          cmdCtx,
          { requestTimeoutMs: 60_000 },
        )
        .then(() => undefined);
      connecting.set(bash, pending);
    }
    await pending;
  }
  ```

- [ ] Run it and confirm it passes. Command: `pnpm --filter @ag-bash/browser test` — expect `Test Files 1 passed (1)`, `Tests 3 passed (3)`. Also `pnpm --filter @ag-bash/bash build` (rebuild core `dist/` so downstream typechecks see Task 2's new export — verified live this is required: `packages/browser`'s `tsc --noEmit` resolves `@ag-bash/bash` via `node_modules` -> `packages/bash/dist`, which is stale until rebuilt) followed by `pnpm --filter @ag-bash/browser typecheck` (expect clean) and `pnpm --filter @ag-bash/browser lint` (expect clean, after running `npx biome check --write .` from `packages/browser/` once to apply this repo's formatting conventions).

- [ ] Commit.
  ```bash
  git add packages/browser/package.json packages/browser/tsconfig.json packages/browser/vitest.config.ts packages/browser/src/connection.ts packages/browser/src/connection.test.ts pnpm-lock.yaml
  git commit -m "feat(browser): scaffold @ag-bash/browser package with a lazy browser-harness-mcp connection helper"
  ```

---

### Task 4: Implement the curated `ag_browser_*` tool suite

**Files:**
- Create: `packages/browser/src/tools.ts`
- Create: `packages/browser/src/tools.test.ts`

**Interfaces:** Consumes: `buildTool`, `type ToolboxTool` (from `@ag-bash/bash`, Task 2); `BROWSER_HARNESS_CONNECTION_ID`, `ensureBrowserHarnessConnection` (from `./connection.js`, Task 3). Produces: `BrowserGotoTool`, `BrowserClickTool`, `BrowserTypeTool`, `BrowserPressTool`, `BrowserScreenshotTool`, `BrowserJsTool`, `BrowserCdpTool`, `BrowserWaitForElementTool`, `BrowserPageInfoTool` — each a `ToolboxTool<TArgs, string>` — which Task 5's `registerBrowserTools` registers onto `bash.toolbox`.

Each tool maps 1:1 onto a real `browser-harness-mcp` tool (verified schemas: `browser_goto`, `browser_click`, `browser_type`, `browser_press`, `browser_screenshot`, `browser_js`, `browser_cdp`, `browser_wait_for_element`, `browser_page_info`).

- [ ] Write the failing test. Create `packages/browser/src/tools.test.ts`:
  ```ts
  import { Bash } from "@ag-bash/bash";
  import { describe, expect, it, vi } from "vitest";
  import { BROWSER_HARNESS_CONNECTION_ID } from "./connection.js";
  import {
    BrowserClickTool,
    BrowserGotoTool,
    BrowserPageInfoTool,
  } from "./tools.js";

  function fakeConnection() {
    return {
      id: BROWSER_HARNESS_CONNECTION_ID,
      name: BROWSER_HARNESS_CONNECTION_ID,
      type: "stdio" as const,
      status: "connected" as const,
      tools: [],
      transport: { init: vi.fn(), send: vi.fn(), notify: vi.fn(), close: vi.fn() },
    };
  }

  describe("ag_browser_* tool definitions", () => {
    it("ag_browser_goto delegates to the browser-harness browser_goto tool", async () => {
      const bash = new Bash();
      vi.spyOn(bash.services.mcpClient, "listConnections").mockReturnValue([
        fakeConnection(),
      ]);
      const callTool = vi
        .spyOn(bash.services.mcpClient, "callTool")
        .mockResolvedValue({ content: [{ type: "text", text: "navigated" }] });

      const result = await BrowserGotoTool.execute(bash, {
        url: "https://example.com",
      });

      expect(callTool).toHaveBeenCalledWith(
        BROWSER_HARNESS_CONNECTION_ID,
        "browser_goto",
        { url: "https://example.com" },
        bash,
      );
      expect(result).toBe(
        JSON.stringify({ content: [{ type: "text", text: "navigated" }] }, null, 2),
      );
    });

    it("ag_browser_click is destructive and denied in plan mode", async () => {
      const bash = new Bash();
      bash.setMode("plan");
      const permission = await BrowserClickTool.checkPermissions(bash, {
        x: 10,
        y: 20,
      });
      expect(permission.behavior).toBe("deny");
    });

    it("ag_browser_page_info is read-only and allowed in plan mode", async () => {
      const bash = new Bash();
      bash.setMode("plan");
      const permission = await BrowserPageInfoTool.checkPermissions(bash, {});
      expect(permission.behavior).toBe("allow");
    });
  });
  ```

- [ ] Run it and confirm it fails. Command: `pnpm --filter @ag-bash/browser test` — expect `Error: Cannot find module './tools.js' imported from .../packages/browser/src/tools.test.ts` (module does not exist yet).

- [ ] Write the minimal implementation. Create `packages/browser/src/tools.ts`:
  ```ts
  import { buildTool, type ToolboxTool } from "@ag-bash/bash";
  import { z } from "zod";
  import { BROWSER_HARNESS_CONNECTION_ID, ensureBrowserHarnessConnection } from "./connection.js";

  /**
   * Format a raw MCP tools/call result the same way McpToolBridge.callTool
   * formats its own generic passthrough tools: strings pass through,
   * everything else is pretty-printed JSON.
   */
  function formatMcpResult(result: unknown): string {
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }

  interface BrowserToolSpec<TArgs extends Record<string, unknown>> {
    name: string;
    harnessTool: string;
    description: string;
    parameters: z.ZodType<TArgs>;
    isReadOnly: boolean;
    isDestructive: boolean;
  }

  /**
   * Build one ag_browser_* tool that delegates to a single browser-harness-mcp
   * tool. `checkPermissions` is intentionally omitted so buildTool's default
   * (deny destructive tools while `bash.getMode() === "plan"`) applies —
   * matching the convention in packages/bash/src/agentic/EditTool.ts.
   */
  function buildBrowserTool<TArgs extends Record<string, unknown>>(
    spec: BrowserToolSpec<TArgs>,
  ): ToolboxTool<TArgs, string> {
    return buildTool<TArgs, string>({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      isReadOnly: spec.isReadOnly,
      isDestructive: spec.isDestructive,
      execute: async (bash, args) => {
        await ensureBrowserHarnessConnection(bash);
        const result = await bash.services.mcpClient.callTool(
          BROWSER_HARNESS_CONNECTION_ID,
          spec.harnessTool,
          args,
          bash,
        );
        return formatMcpResult(result);
      },
    });
  }

  interface GotoArgs extends Record<string, unknown> {
    url: string;
  }
  export const BrowserGotoTool: ToolboxTool<GotoArgs, string> = buildBrowserTool({
    name: "ag_browser_goto",
    harnessTool: "browser_goto",
    description: "Navigate the current browser tab to a URL (browser-harness).",
    parameters: z.object({
      url: z.string().describe("The URL to navigate the current tab to."),
    }),
    isReadOnly: false,
    isDestructive: true,
  });

  interface ClickArgs extends Record<string, unknown> {
    x: number;
    y: number;
    button?: "left" | "right" | "middle";
    clicks?: number;
  }
  export const BrowserClickTool: ToolboxTool<ClickArgs, string> = buildBrowserTool({
    name: "ag_browser_click",
    harnessTool: "browser_click",
    description: "Click at screen coordinates in the current browser tab (browser-harness).",
    parameters: z.object({
      x: z.number().int().describe("X screen coordinate to click, in viewport pixels."),
      y: z.number().int().describe("Y screen coordinate to click, in viewport pixels."),
      button: z
        .enum(["left", "right", "middle"])
        .optional()
        .describe("Mouse button to click. Defaults to 'left'."),
      clicks: z
        .number()
        .int()
        .optional()
        .describe("Number of clicks (2 for double-click). Defaults to 1."),
    }),
    isReadOnly: false,
    isDestructive: true,
  });

  interface TypeArgs extends Record<string, unknown> {
    text: string;
  }
  export const BrowserTypeTool: ToolboxTool<TypeArgs, string> = buildBrowserTool({
    name: "ag_browser_type",
    harnessTool: "browser_type",
    description: "Insert text into the currently focused element (browser-harness).",
    parameters: z.object({
      text: z.string().describe("Text to insert into the currently focused element."),
    }),
    isReadOnly: false,
    isDestructive: true,
  });

  interface PressArgs extends Record<string, unknown> {
    key: string;
    modifiers?: number;
  }
  export const BrowserPressTool: ToolboxTool<PressArgs, string> = buildBrowserTool({
    name: "ag_browser_press",
    harnessTool: "browser_press",
    description: "Press a key in the current browser tab (browser-harness).",
    parameters: z.object({
      key: z.string().describe("Key to press, e.g. 'Enter', 'Tab', 'ArrowDown'."),
      modifiers: z
        .number()
        .int()
        .optional()
        .describe(
          "Modifier bitfield: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift. Combine by summing. Defaults to 0.",
        ),
    }),
    isReadOnly: false,
    isDestructive: true,
  });

  interface ScreenshotArgs extends Record<string, unknown> {
    full?: boolean;
    max_dim?: number;
    path?: string;
  }
  export const BrowserScreenshotTool: ToolboxTool<ScreenshotArgs, string> = buildBrowserTool({
    name: "ag_browser_screenshot",
    harnessTool: "browser_screenshot",
    description: "Capture a PNG screenshot of the current browser tab (browser-harness).",
    parameters: z.object({
      full: z
        .boolean()
        .optional()
        .describe("Capture the full scrollable page instead of the viewport. Defaults to false."),
      max_dim: z
        .number()
        .int()
        .optional()
        .describe("Downscale the result if larger than this pixel dimension."),
      path: z
        .string()
        .optional()
        .describe("Filesystem path to save the PNG to. A temp file is used if omitted."),
    }),
    isReadOnly: true,
    isDestructive: false,
  });

  interface JsArgs extends Record<string, unknown> {
    expression: string;
    target_id?: string;
  }
  export const BrowserJsTool: ToolboxTool<JsArgs, string> = buildBrowserTool({
    name: "ag_browser_js",
    harnessTool: "browser_js",
    description: "Evaluate a JavaScript expression in the current browser tab (browser-harness).",
    parameters: z.object({
      expression: z.string().describe("JavaScript expression to evaluate in the current tab."),
      target_id: z
        .string()
        .optional()
        .describe("Iframe target id to evaluate in, instead of the top-level frame."),
    }),
    isReadOnly: false,
    isDestructive: true,
  });

  interface CdpArgs extends Record<string, unknown> {
    method: string;
    params?: Record<string, unknown>;
  }
  export const BrowserCdpTool: ToolboxTool<CdpArgs, string> = buildBrowserTool({
    name: "ag_browser_cdp",
    harnessTool: "browser_cdp",
    description: "Call a raw Chrome DevTools Protocol method (browser-harness escape hatch).",
    parameters: z.object({
      method: z.string().describe("Raw Chrome DevTools Protocol method, e.g. 'DOM.getBoxModel'."),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Parameters for the CDP method, passed through as-is."),
    }),
    isReadOnly: false,
    isDestructive: true,
  });

  interface WaitForElementArgs extends Record<string, unknown> {
    selector: string;
    timeout?: number;
    visible?: boolean;
  }
  export const BrowserWaitForElementTool: ToolboxTool<WaitForElementArgs, string> = buildBrowserTool({
    name: "ag_browser_wait_for_element",
    harnessTool: "browser_wait_for_element",
    description: "Wait for an element matching a CSS selector to appear (browser-harness).",
    parameters: z.object({
      selector: z.string().describe("CSS selector of the element to wait for."),
      timeout: z
        .number()
        .optional()
        .describe("Maximum seconds to wait before giving up. Defaults to 10."),
      visible: z
        .boolean()
        .optional()
        .describe(
          "Also require the element to be rendered (not just present in the DOM). Defaults to false.",
        ),
    }),
    isReadOnly: true,
    isDestructive: false,
  });

  // biome-ignore lint/complexity/noBannedTypes: browser_page_info takes no arguments
  type PageInfoArgs = Record<string, unknown>;
  export const BrowserPageInfoTool: ToolboxTool<PageInfoArgs, string> = buildBrowserTool({
    name: "ag_browser_page_info",
    harnessTool: "browser_page_info",
    description: "Return current tab metadata: url, title, viewport and scroll sizes (browser-harness).",
    parameters: z.object({}),
    isReadOnly: true,
    isDestructive: false,
  });
  ```

- [ ] Run it and confirm it passes. Command: `pnpm --filter @ag-bash/browser test` — expect `Test Files 1 passed (1)`, `Tests 3 passed (3)`. Also `pnpm --filter @ag-bash/browser typecheck` and `pnpm --filter @ag-bash/browser lint` (run `npx biome check --write .` first to apply formatting).

- [ ] Commit.
  ```bash
  git add packages/browser/src/tools.ts packages/browser/src/tools.test.ts
  git commit -m "feat(browser): add the nine curated ag_browser_* tools backed by browser-harness-mcp"
  ```

---

### Task 5: `registerBrowserTools` export + full toolbox-lifecycle test

**Files:**
- Create: `packages/browser/src/index.ts`
- Create: `packages/browser/src/index.test.ts`

**Interfaces:** Consumes: the nine tool constants from `./tools.js` (Task 4). Produces: `registerBrowserTools(bash: Bash): void` — the single function Task 6's `@ag-bash/mcp-server` wiring calls.

- [ ] Write the failing test. Create `packages/browser/src/index.test.ts`:
  ```ts
  import { Bash } from "@ag-bash/bash";
  import { describe, expect, it, vi } from "vitest";
  import { BROWSER_HARNESS_CONNECTION_ID } from "./connection.js";
  import { registerBrowserTools } from "./index.js";

  function fakeConnection() {
    return {
      id: BROWSER_HARNESS_CONNECTION_ID,
      name: BROWSER_HARNESS_CONNECTION_ID,
      type: "stdio" as const,
      status: "connected" as const,
      tools: [],
      transport: { init: vi.fn(), send: vi.fn(), notify: vi.fn(), close: vi.fn() },
    };
  }

  const EXPECTED_TOOL_NAMES = [
    "ag_browser_goto",
    "ag_browser_click",
    "ag_browser_type",
    "ag_browser_press",
    "ag_browser_screenshot",
    "ag_browser_js",
    "ag_browser_cdp",
    "ag_browser_wait_for_element",
    "ag_browser_page_info",
  ];

  describe("registerBrowserTools", () => {
    it("registers all nine ag_browser_* tools onto the toolbox", () => {
      const bash = new Bash();
      registerBrowserTools(bash);
      const tools = bash.toolbox.getAgenticTools(bash);
      for (const name of EXPECTED_TOOL_NAMES) {
        expect(tools[name]).toBeDefined();
      }
    });

    it("routes a full toolbox call through to the browser-harness MCP connection", async () => {
      const bash = new Bash();
      registerBrowserTools(bash);
      vi.spyOn(bash.services.mcpClient, "listConnections").mockReturnValue([
        fakeConnection(),
      ]);
      vi.spyOn(bash.services.mcpClient, "callTool").mockResolvedValue({
        content: [{ type: "text", text: '{"url":"https://example.com"}' }],
      });

      const result = await bash.toolbox.callTool(bash, "ag_browser_page_info", {});

      expect(result).toBe(
        JSON.stringify(
          { content: [{ type: "text", text: '{"url":"https://example.com"}' }] },
          null,
          2,
        ),
      );
    });

    it("denies ag_browser_click in plan mode via the full toolbox lifecycle", async () => {
      const bash = new Bash();
      registerBrowserTools(bash);
      bash.setMode("plan");

      const result = await bash.toolbox.callTool(bash, "ag_browser_click", {
        x: 1,
        y: 2,
      });

      expect(result).toBe(
        "Permission Denied: Cannot execute destructive tool 'ag_browser_click' in plan mode.",
      );
    });
  });
  ```

- [ ] Run it and confirm it fails. Command: `pnpm --filter @ag-bash/browser test` — expect `Error: Cannot find module './index.js' imported from .../packages/browser/src/index.test.ts` (module does not exist yet; note `tools.ts`/`connection.ts` already resolve fine from Tasks 3-4).

- [ ] Write the minimal implementation. Create `packages/browser/src/index.ts`:
  ```ts
  import type { Bash } from "@ag-bash/bash";
  import {
    BrowserCdpTool,
    BrowserClickTool,
    BrowserGotoTool,
    BrowserJsTool,
    BrowserPageInfoTool,
    BrowserPressTool,
    BrowserScreenshotTool,
    BrowserTypeTool,
    BrowserWaitForElementTool,
  } from "./tools.js";

  export {
    BROWSER_HARNESS_CONNECTION_ID,
    ensureBrowserHarnessConnection,
  } from "./connection.js";
  export {
    BrowserCdpTool,
    BrowserClickTool,
    BrowserGotoTool,
    BrowserJsTool,
    BrowserPageInfoTool,
    BrowserPressTool,
    BrowserScreenshotTool,
    BrowserTypeTool,
    BrowserWaitForElementTool,
  };

  const BROWSER_TOOLS = [
    BrowserGotoTool,
    BrowserClickTool,
    BrowserTypeTool,
    BrowserPressTool,
    BrowserScreenshotTool,
    BrowserJsTool,
    BrowserCdpTool,
    BrowserWaitForElementTool,
    BrowserPageInfoTool,
  ] as const;

  /**
   * Register the curated `ag_browser_*` tool suite onto a Bash instance's
   * toolbox. Once registered, the tools are usable both from bash scripts
   * (`bash.toolbox.callTool(bash, "ag_browser_goto", {...})`) and, if the
   * caller is an MCP server built on `bash.toolbox` (e.g.
   * @ag-bash/mcp-server's `McpToolBridge`), automatically surfaced as MCP
   * tools too — no MCP-server-side protocol code needed beyond calling this
   * function once at startup.
   */
  export function registerBrowserTools(bash: Bash): void {
    for (const tool of BROWSER_TOOLS) {
      bash.toolbox.registerTool(tool);
    }
  }
  ```

- [ ] Run it and confirm it passes. Command: `pnpm --filter @ag-bash/browser test` — expect `Test Files 2 passed (2)` (this file + `tools.test.ts`/`connection.test.ts` from earlier tasks), `Tests 9 passed (9)`. Also `pnpm --filter @ag-bash/browser build` (verify a clean `tsc` build producing `dist/index.d.ts` + `dist/index.js`, with test files excluded per the `build` script's `find ... -delete` cleanup) and `pnpm --filter @ag-bash/browser lint`.

- [ ] Commit.
  ```bash
  git add packages/browser/src/index.ts packages/browser/src/index.test.ts
  git commit -m "feat(browser): export registerBrowserTools, wiring the ag_browser_* suite onto bash.toolbox"
  ```

---

### Task 6: Optionally load `@ag-bash/browser` from `@ag-bash/mcp-server`

**Files:**
- Modify: `packages/mcp-server/package.json` (add `optionalDependencies`, update `build:bundle` script)
- Modify: `packages/mcp-server/src/index.ts` (constructor + new `loadOptionalPackages` method + bottom auto-start block)
- Create: `packages/mcp-server/src/browser-tools.test.ts`

**Interfaces:** Consumes: `registerBrowserTools(bash: Bash): void` (from `@ag-bash/browser`, Task 5). Produces: `AgBashServer.loadOptionalPackages(): Promise<void>` (new public method; constructor gains a fourth, optional, backward-compatible parameter for test injection).

- [ ] Write the failing test. Create `packages/mcp-server/src/browser-tools.test.ts`:
  ```ts
  import { describe, expect, it, vi } from "vitest";
  import { AgBashServer } from "./index.js";

  describe("optional @ag-bash/browser loading", () => {
    it("registers ag_browser_* tools when @ag-bash/browser resolves", async () => {
      const registerBrowserTools = vi.fn();
      const server = new AgBashServer(async () => ({ registerBrowserTools }));

      await server.loadOptionalPackages();

      expect(registerBrowserTools).toHaveBeenCalledTimes(1);
    });

    it("starts normally when @ag-bash/browser is absent", async () => {
      const server = new AgBashServer(async () => {
        throw new Error("Cannot find package '@ag-bash/browser'");
      });

      await expect(server.loadOptionalPackages()).resolves.toBeUndefined();
    });
  });
  ```

- [ ] Run it and confirm it fails. Command: `pnpm --filter @ag-bash/mcp-server test run src/browser-tools.test.ts`. Expected failure: `TypeError: server.loadOptionalPackages is not a function`. (The pristine `AgBashServer` constructor takes zero parameters; JS silently ignores the extra constructor argument the test passes rather than erroring, and constructs a real `AgBashServer` backed by a real `new Bash()` — but the `loadOptionalPackages` method itself does not exist yet, which is what fails.)

- [ ] Write the minimal implementation. In `packages/mcp-server/src/index.ts`:

  1. Replace the constructor (currently `constructor() { ... }`) with a version taking an injectable, defaulted import function:
     ```ts
     constructor(
       private readonly importBrowserPackage: () => Promise<{
         registerBrowserTools: (bash: Bash) => void;
       }> = () => import("@ag-bash/browser"),
     ) {
       // Initialize the persistent Bash engine
       this.bash = new Bash({
         network: {
           dangerouslyAllowFullInternetAccess: true,
           denyPrivateRanges: true,
         },
         runtimes: { python: true, javascript: true },
         security: { defenseInDepth: true },
       });

       // Initialize the tool bridge for BashToolbox tools
       this.toolBridge = new McpToolBridge(this.bash);

       // Initialize rate limiter (60 requests per minute)
       this.rateLimiter = new RateLimiter(60, 60_000);
     }

     /**
      * Load @ag-bash/browser if it is installed and register its ag_browser_*
      * tools onto this server's toolbox. It is an optionalDependency
      * (mirrors the @mongodb-js/zstd / node-liblzma pattern in
      * packages/bash/src/commands/tar/archive.ts, applied at package
      * granularity): absence is expected and not an error.
      */
     async loadOptionalPackages(): Promise<void> {
       try {
         const browserPkg = await this.importBrowserPackage();
         browserPkg.registerBrowserTools(this.bash);
       } catch {
         // @ag-bash/browser not installed — browser tools are simply
         // unavailable; the rest of the server still starts normally.
       }
     }
     ```

  2. Update the bottom auto-start block from:
     ```ts
     if (!process.env.VITEST) {
       const server = new AgBashServer();
       server.run();
     }
     ```
     to:
     ```ts
     if (!process.env.VITEST) {
       const server = new AgBashServer();
       await server.loadOptionalPackages();
       server.run();
     }
     ```

  In `packages/mcp-server/package.json`:

  3. Add `optionalDependencies` (new top-level key, alongside the existing `dependencies`):
     ```json
       "optionalDependencies": {
         "@ag-bash/browser": "workspace:*",
         "@mongodb-js/zstd": "^7.0.0",
         "node-liblzma": "^2.0.3"
       },
     ```
     (the `@mongodb-js/zstd`/`node-liblzma` entries already exist — this just adds `@ag-bash/browser` to the same object; do not duplicate the key.)

  4. Add `--external:@ag-bash/browser` to the `build:bundle` script's esbuild flags. This is required, not cosmetic: `build:bundle` has no `--splitting` flag, so esbuild would otherwise try to statically resolve and inline `@ag-bash/browser` at build time — exactly the failure mode the existing `--external:@mongodb-js/zstd --external:node-liblzma` flags already prevent for the native-addon optionals. Updated script:
     ```json
       "build:bundle": "esbuild src/index.ts --bundle --platform=node --format=esm --minify --outfile=dist/index.js --banner:js='#!/usr/bin/env node' --external:@ag-bash/browser --external:sql.js --external:quickjs-emscripten --external:@mongodb-js/zstd --external:node-liblzma --external:seek-bzip",
     ```

- [ ] Run it and confirm it passes. Command: `pnpm --filter @ag-bash/mcp-server test run src/browser-tools.test.ts` — expect `Test Files 1 passed (1)`, `Tests 2 passed (2)`. Also run the pre-existing suite to confirm the constructor change doesn't break it: `pnpm --filter @ag-bash/mcp-server test run src/index.test.ts` (that file never instantiates the real `AgBashServer`, per its `TestableServer` duplicate — confirm it still passes unmodified) and `pnpm --filter @ag-bash/mcp-server typecheck`.

- [ ] Commit.
  ```bash
  git add packages/mcp-server/package.json packages/mcp-server/src/index.ts packages/mcp-server/src/browser-tools.test.ts
  git commit -m "feat(mcp-server): optionally load @ag-bash/browser's ag_browser_* tools at startup"
  ```
