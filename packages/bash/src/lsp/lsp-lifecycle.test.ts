/**
 * Language-server lifecycle.
 *
 * A Bash instance must not own a language-server process, pipe or pending
 * request until an LSP feature is actually used, must start at most one server
 * per file extension however many callers arrive together, and must give all
 * of it back on destroy().
 *
 * `node:child_process` is mocked, so no real process is ever started. The fake
 * server speaks just enough JSON-RPC over the same stdio framing that
 * LSPConnection uses, which means the real LSPConnection, LSPManager and Bash
 * code paths run unchanged.
 */

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bash } from "../Bash.js";
import { createDefaultServices } from "../services/ServiceContainer.js";
import { LSPManager } from "./LSPManager.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

/**
 * - reply: answers every request
 * - hold-initialize: answers nothing until releaseInitialize() is called
 * - hold-requests: answers `initialize`, never answers a later request
 * - spawn-error: the process fails to start (ENOENT)
 */
type ServerBehaviour =
  | "reply"
  | "hold-initialize"
  | "hold-requests"
  | "spawn-error";

interface ReceivedMessage {
  readonly method: string;
  readonly id: number | undefined;
}

const HEADER_PATTERN = /Content-Length: (\d+)\r\n\r\n/;

/** A stand-in for the ChildProcess that LSPConnection spawns. */
class FakeLanguageServer extends EventEmitter {
  readonly received: ReceivedMessage[] = [];
  /** Everything the server saw or said, in order. */
  readonly timeline: string[] = [];
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly kill = vi.fn(() => {
    process.nextTick(() => this.emit("exit", null, "SIGTERM"));
    return true;
  });
  private buffer = Buffer.alloc(0);
  private heldInitializeId: number | undefined;

  constructor(
    readonly index: number,
    private readonly behaviour: ServerBehaviour,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        this.onInput(chunk);
        done();
      },
    });
    if (behaviour === "spawn-error") {
      process.nextTick(() => {
        this.emit(
          "error",
          Object.assign(new Error("spawn typescript-language-server ENOENT"), {
            code: "ENOENT",
          }),
        );
      });
    }
  }

  /** Answer an `initialize` request that was being held back. */
  releaseInitialize(): void {
    if (this.heldInitializeId === undefined) return;
    const id = this.heldInitializeId;
    this.heldInitializeId = undefined;
    this.replyToInitialize(id);
  }

  get methods(): string[] {
    return this.received.map((message) => message.method);
  }

  private onInput(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const match = HEADER_PATTERN.exec(this.buffer.toString("utf-8"));
      if (!match) return;
      const headerLength = match[0].length;
      const bodyLength = Number.parseInt(match[1], 10);
      if (this.buffer.length < headerLength + bodyLength) return;
      const body = this.buffer.toString(
        "utf-8",
        headerLength,
        headerLength + bodyLength,
      );
      this.buffer = this.buffer.subarray(headerLength + bodyLength);
      this.onMessage(JSON.parse(body) as { method: string; id?: number });
    }
  }

  private onMessage(message: { method: string; id?: number }): void {
    this.received.push({ method: message.method, id: message.id });
    this.timeline.push(`recv ${message.method}`);
    if (message.id === undefined || this.behaviour === "spawn-error") return;
    if (message.method === "initialize") {
      if (this.behaviour === "hold-initialize") {
        this.heldInitializeId = message.id;
        return;
      }
      this.replyToInitialize(message.id);
      return;
    }
    if (this.behaviour === "hold-requests") return;
    this.reply(message.id, { servedBy: this.index, method: message.method });
  }

  private replyToInitialize(id: number): void {
    this.timeline.push("reply initialize");
    this.reply(id, { capabilities: Object.create(null) });
  }

  private reply(id: number, result: unknown): void {
    if (this.stdout.destroyed) return;
    const json = JSON.stringify({ jsonrpc: "2.0", id, result });
    this.stdout.write(
      `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`,
    );
  }
}

let behaviour: ServerBehaviour = "reply";
const servers: FakeLanguageServer[] = [];
const instances: Bash[] = [];

function track(bash: Bash): Bash {
  instances.push(bash);
  return bash;
}

/** Let queued microtasks, nextTicks and I/O callbacks run. */
async function flush(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function definitionRequest(filePath: string) {
  return {
    method: "textDocument/definition",
    params: { symbolName: "foo" },
    filePath,
  };
}

const SERVED_BY_FIRST = {
  servedBy: 0,
  method: "textDocument/definition",
};

beforeEach(() => {
  behaviour = "reply";
  servers.length = 0;
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const server = new FakeLanguageServer(servers.length, behaviour);
    servers.push(server);
    return server;
  });
});

afterEach(() => {
  for (const bash of instances.splice(0)) {
    bash.destroy();
  }
});

describe("language server lifecycle", () => {
  describe("construction", () => {
    it("constructing and destroying a Bash spawns no language server", async () => {
      const bash = track(new Bash());
      await flush();
      expect(spawnMock).not.toHaveBeenCalled();

      bash.destroy();
      bash.destroy();
      await flush();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("running ordinary commands does not start a language server", async () => {
      const bash = track(new Bash());
      const result = await bash.exec("echo hello > /tmp/a.ts && cat /tmp/a.ts");
      expect(result.stdout).toBe("hello\n");
      await flush();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("file-change notifications do not start a language server", async () => {
      const bash = track(new Bash());
      bash.lsp.notifyDidChange("/a.ts", "export const a = 1;");
      await bash.writeFileDirect("/b.ts", "export const b = 2;");
      await flush();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("the first declaration for an extension wins", async () => {
      const bash = track(new Bash());
      const manager = new LSPManager();
      manager.registerServer("ts", "first-server", ["--first"]);
      manager.registerServer("ts", "second-server", ["--second"]);

      await manager.sendRequest(bash, definitionRequest("/a.ts"));
      manager.dispose();

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith(
        "first-server",
        ["--first"],
        expect.anything(),
      );
    });

    it("a file type with no language server never starts one", async () => {
      const bash = track(new Bash());
      await expect(
        bash.lsp.sendRequest(bash, definitionRequest("/a.py")),
      ).resolves.toBeUndefined();
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  describe("first use", () => {
    it("starts one server on the first request and answers through it", async () => {
      const bash = track(new Bash());
      expect(spawnMock).not.toHaveBeenCalled();

      const result = await bash.lsp.sendRequest(
        bash,
        definitionRequest("/a.ts"),
      );

      expect(result).toEqual(SERVED_BY_FIRST);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith(
        "typescript-language-server",
        ["--stdio"],
        expect.anything(),
      );
      expect(servers[0].methods).toEqual([
        "initialize",
        "initialized",
        "textDocument/definition",
      ]);
    });

    it("shares one start between concurrent first requests", async () => {
      behaviour = "hold-initialize";
      const bash = track(new Bash());

      const pending = Array.from({ length: 5 }, () =>
        bash.lsp.sendRequest(bash, definitionRequest("/a.ts")),
      );
      await flush();

      // One spawn, and nothing but the handshake has reached the server yet.
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(servers[0].methods).toEqual(["initialize"]);

      servers[0].releaseInitialize();
      const results = await Promise.all(pending);

      expect(results).toEqual(Array(5).fill(SERVED_BY_FIRST));
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(servers[0].methods).toEqual([
        "initialize",
        "initialized",
        ...Array(5).fill("textDocument/definition"),
      ]);
    });

    it("keeps using the same server for later requests", async () => {
      const bash = track(new Bash());
      await bash.lsp.sendRequest(bash, definitionRequest("/a.ts"));
      await bash.lsp.sendRequest(bash, definitionRequest("/b.ts"));
      await bash.lsp.sendRequest(bash, definitionRequest("/c.ts"));
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it("starts one server per extension, as the constructor used to", async () => {
      const bash = track(new Bash());
      await bash.lsp.sendRequest(bash, definitionRequest("/a.ts"));
      await bash.lsp.sendRequest(bash, definitionRequest("/a.js"));
      await bash.lsp.sendRequest(bash, definitionRequest("/b.js"));
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it("forwards file-change notifications once a server is running", async () => {
      const bash = track(new Bash());
      await bash.lsp.sendRequest(bash, definitionRequest("/a.ts"));

      bash.lsp.notifyDidChange("/a.ts", "export const a = 1;");
      await flush();

      expect(servers[0].methods).toContain("textDocument/didChange");
    });

    it("falls back to the semantic engine when the server cannot be spawned", async () => {
      behaviour = "spawn-error";
      const bash = track(new Bash());

      await expect(
        bash.lsp.sendRequest(bash, definitionRequest("/a.ts")),
      ).resolves.toBeUndefined();
      await expect(
        bash.lsp.sendRequest(bash, definitionRequest("/a.js")),
      ).resolves.toBeUndefined();
      await expect(
        bash.lsp.sendRequest(bash, definitionRequest("/b.ts")),
      ).resolves.toBeUndefined();

      // One attempt per extension: a missing binary is not retried per request.
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("destroy()", () => {
    it("is safe before any use and when repeated", async () => {
      const bash = track(new Bash());
      expect(() => {
        bash.destroy();
        bash.destroy();
      }).not.toThrow();
      await bash[Symbol.asyncDispose]();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("closes the server a request started", async () => {
      const bash = track(new Bash());
      await bash.lsp.sendRequest(bash, definitionRequest("/a.ts"));
      expect(servers[0].kill).not.toHaveBeenCalled();

      bash.destroy();

      expect(servers[0].kill).toHaveBeenCalledTimes(1);
      expect(servers[0].stdin.destroyed).toBe(true);
      expect(servers[0].stdout.destroyed).toBe(true);
      expect(servers[0].stderr.destroyed).toBe(true);
    });

    it("closes every server it started, and only once each", async () => {
      const bash = track(new Bash());
      await bash.lsp.sendRequest(bash, definitionRequest("/a.ts"));
      await bash.lsp.sendRequest(bash, definitionRequest("/a.js"));

      bash.destroy();
      bash.destroy();
      await bash[Symbol.asyncDispose]();

      expect(servers).toHaveLength(2);
      expect(servers[0].kill).toHaveBeenCalledTimes(1);
      expect(servers[1].kill).toHaveBeenCalledTimes(1);
    });

    it("cancels a start that is still waiting for the server to initialize", async () => {
      behaviour = "hold-initialize";
      const bash = track(new Bash());
      const pending = bash.lsp.sendRequest(bash, definitionRequest("/a.ts"));
      await flush();
      expect(servers).toHaveLength(1);

      bash.destroy();

      expect(servers[0].kill).toHaveBeenCalledTimes(1);
      // The waiting caller is released with the semantic-engine fallback.
      await expect(pending).resolves.toBeUndefined();

      // A late reply from the closed server changes nothing.
      servers[0].releaseInitialize();
      await flush();
      expect(servers[0].methods).toEqual(["initialize"]);
    });

    it("settles a request the server has not answered yet", async () => {
      behaviour = "hold-requests";
      const bash = track(new Bash());
      const pending = bash.lsp.sendRequest(bash, definitionRequest("/a.ts"));
      await flush();
      expect(servers[0].methods).toEqual([
        "initialize",
        "initialized",
        "textDocument/definition",
      ]);

      bash.destroy();

      await expect(pending).resolves.toBeNull();
    });

    it("a new request made right after destroy() waits for its own handshake, and the cancelled callers do not use the new server", async () => {
      behaviour = "hold-initialize";
      const bash = track(new Bash());
      const cancelled = [
        bash.lsp.sendRequest(bash, definitionRequest("/a.ts")),
        bash.lsp.sendRequest(bash, definitionRequest("/b.ts")),
      ];
      await flush();
      expect(servers).toHaveLength(1);

      bash.destroy();
      const fresh = bash.lsp.sendRequest(bash, definitionRequest("/c.ts"));
      await flush();

      // The second server is still mid-handshake. The callers that destroy()
      // cancelled have fallen back; none of them may write to it.
      expect(servers).toHaveLength(2);
      expect(servers[1].timeline).toEqual(["recv initialize"]);
      await expect(Promise.all(cancelled)).resolves.toEqual([
        undefined,
        undefined,
      ]);

      // The first start has settled by now. A caller arriving later still
      // waits for the second start: it must not take the shortcut either.
      const late = bash.lsp.sendRequest(bash, definitionRequest("/d.ts"));
      await flush();
      expect(servers[1].timeline).toEqual(["recv initialize"]);

      servers[1].releaseInitialize();

      const served = { servedBy: 1, method: "textDocument/definition" };
      await expect(Promise.all([fresh, late])).resolves.toEqual([
        served,
        served,
      ]);
      expect(servers[1].timeline).toEqual([
        "recv initialize",
        "reply initialize",
        "recv initialized",
        "recv textDocument/definition",
        "recv textDocument/definition",
      ]);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it("an instance sharing a manager: destroying the other settles its in-flight request, and its next use restarts the server", async () => {
      behaviour = "hold-requests";
      const first = track(new Bash());
      const second = track(new Bash({ services: { lspManager: first.lsp } }));
      const pending = second.lsp.sendRequest(
        second,
        definitionRequest("/a.ts"),
      );
      await flush();
      expect(servers).toHaveLength(1);

      first.destroy();
      await expect(pending).resolves.toBeNull();
      expect(servers[0].kill).toHaveBeenCalledTimes(1);

      behaviour = "reply";
      const again = await second.lsp.sendRequest(
        second,
        definitionRequest("/a.ts"),
      );
      expect(again).toEqual({ servedBy: 1, method: "textDocument/definition" });
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it("leaves the instance usable: the next request starts a fresh server", async () => {
      const bash = track(new Bash());
      await bash.lsp.sendRequest(bash, definitionRequest("/a.ts"));
      bash.destroy();

      // exec() keeps working after destroy(), as it always has.
      const echoed = await bash.exec("echo still-here");
      expect(echoed.stdout).toBe("still-here\n");

      const result = await bash.lsp.sendRequest(
        bash,
        definitionRequest("/a.ts"),
      );
      expect(result).toEqual({
        servedBy: 1,
        method: "textDocument/definition",
      });
      expect(spawnMock).toHaveBeenCalledTimes(2);

      bash.destroy();
      expect(servers[0].kill).toHaveBeenCalledTimes(1);
      expect(servers[1].kill).toHaveBeenCalledTimes(1);
    });
  });

  describe("service container", () => {
    it("disposes the language-server manager with the other services", async () => {
      const container = createDefaultServices();
      const disposeSpy = vi.spyOn(container.lspManager, "dispose");

      await container.dispose();

      expect(disposeSpy).toHaveBeenCalledOnce();
    });

    it("does not dispose a language-server manager that was never used", async () => {
      const disposeSpy = vi.spyOn(LSPManager.prototype, "dispose");
      const container = createDefaultServices();

      await container.dispose();

      expect(disposeSpy).not.toHaveBeenCalled();
    });
  });
});
