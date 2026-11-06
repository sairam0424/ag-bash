/**
 * LSPConnection on its own: what happens to waiting requests and to the pipes
 * when the connection is closed or its server fails to start.
 *
 * `node:child_process` is mocked, so no process is started. stdin is a
 * recording double (not a real stream), so a write that reaches it is a write
 * the connection chose to make; a real destroyed stream would silently drop it
 * and hide the difference.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LSPConnection } from "./LSPConnection.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

class FakeChild extends EventEmitter {
  readonly stdin = { write: vi.fn(), destroy: vi.fn() };
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

let child: FakeChild;

function open(): LSPConnection {
  return new LSPConnection("typescript-language-server", ["--stdio"]);
}

/**
 * How a request ended: "resolved", or the rejection message. Handlers are
 * attached at once, so a rejection is never reported as unhandled.
 */
function outcome(request: Promise<unknown>): Promise<string> {
  return request.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );
}

function enoent(): Error {
  return Object.assign(new Error("spawn typescript-language-server ENOENT"), {
    code: "ENOENT",
  });
}

beforeEach(() => {
  child = new FakeChild();
  spawnMock.mockReset();
  spawnMock.mockReturnValue(child);
});

describe("LSPConnection", () => {
  it("is available until it is closed", () => {
    const connection = open();
    expect(connection.isAvailable).toBe(true);

    connection.terminate();

    expect(connection.isAvailable).toBe(false);
  });

  describe("terminate()", () => {
    it("releases the process and all three pipes", () => {
      const connection = open();

      connection.terminate();

      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.stdin.destroy).toHaveBeenCalledTimes(1);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
    });

    it("is safe to call again and closes the process only once", () => {
      const connection = open();

      expect(() => {
        connection.terminate();
        connection.terminate();
        connection.terminate();
      }).not.toThrow();

      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.stdin.destroy).toHaveBeenCalledTimes(1);
    });

    it("rejects every request that is still waiting", async () => {
      const connection = open();
      const first = outcome(connection.sendRequest("initialize", {}));
      const second = outcome(connection.sendRequest("shutdown", {}));

      connection.terminate();

      expect(await first).toBe("LSP connection is closed");
      expect(await second).toBe("LSP connection is closed");
    });

    it("refuses new requests without writing to the server", async () => {
      const connection = open();
      connection.terminate();

      await expect(connection.sendRequest("initialize", {})).rejects.toThrow(
        "LSP connection is closed",
      );

      expect(child.stdin.write).not.toHaveBeenCalled();
    });

    it("drops notifications without throwing or writing to the server", () => {
      const connection = open();
      connection.sendNotification("initialized", {});
      expect(child.stdin.write).toHaveBeenCalledTimes(1);

      connection.terminate();

      expect(() =>
        connection.sendNotification("textDocument/didChange", {}),
      ).not.toThrow();
      expect(child.stdin.write).toHaveBeenCalledTimes(1);
    });
  });

  describe("a server that fails to start", () => {
    it("marks the connection unavailable and rejects waiting requests", async () => {
      const connection = open();
      const waiting = outcome(connection.sendRequest("initialize", {}));

      child.emit("error", enoent());

      expect(await waiting).toContain("ENOENT");
      expect(connection.isAvailable).toBe(false);
    });

    it("rejects later requests with the original failure, without writing", async () => {
      const connection = open();
      child.emit("error", enoent());

      await expect(connection.sendRequest("initialize", {})).rejects.toThrow(
        "ENOENT",
      );

      expect(child.stdin.write).not.toHaveBeenCalled();
    });

    it("keeps the first failure when more follow", async () => {
      const connection = open();

      child.emit("error", new Error("first failure"));
      child.emit("error", new Error("second failure"));

      await expect(connection.sendRequest("initialize", {})).rejects.toThrow(
        "first failure",
      );
    });

    it("wraps a failure that is not an Error", async () => {
      const connection = open();

      child.emit("error", "plain string failure");

      const rejection = await connection
        .sendRequest("initialize", {})
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe("plain string failure");
    });

    it("does not print anything: the library must not write to the console", () => {
      const consoleSpies = (["log", "warn", "error"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined),
      );
      const connection = open();

      child.emit("error", enoent());
      connection.terminate();

      for (const spy of consoleSpies) {
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      }
    });
  });
});
