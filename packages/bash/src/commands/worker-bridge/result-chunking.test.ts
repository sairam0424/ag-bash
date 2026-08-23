/**
 * Result-direction chunking + typed size-ceiling tests for the worker bridge.
 *
 * READDIR, HTTP_REQUEST and EXEC_COMMAND used to write their whole result into
 * the 1MB data window in a single shot, so a result larger than the window
 * failed — and failed with an error code (IO_ERROR for readdir/exec,
 * NETWORK_ERROR for HTTP) that a caller could not tell apart from a genuine
 * I/O or network failure. These tests drive results just under, exactly at,
 * just over, and well over the window through each of the three paths, and pin
 * the typed outcome of the remaining hard ceiling on the paths that stay
 * single-shot.
 *
 * Frames are driven by hand (the same frames a worker-side SyncBackend emits)
 * so the tests stay fast and free of a real worker blocking on Atomics.wait —
 * the same approach chunked-transfer.test.ts documents.
 */
import { describe, expect, it } from "vitest";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import type { SecureFetch } from "../../network/fetch.js";
import type { CommandExecOptions, ExecResult } from "../../types.js";
import { BridgeHandler } from "./bridge-handler.js";
import {
  createSharedBuffer,
  ErrorCode,
  MAX_CHUNK_SIZE,
  OpCode,
  type OpCodeType,
  ProtocolBuffer,
  Status,
} from "./protocol.js";

/** Drive one framed round-trip and wait for SUCCESS/ERROR. */
async function driveFrame(
  protocol: ProtocolBuffer,
  opCode: OpCodeType,
  framing: { path?: string; data?: string; offset?: number },
): Promise<number> {
  protocol.reset();
  protocol.setOpCode(opCode);
  protocol.setPath(framing.path ?? "");
  if (framing.data !== undefined) {
    protocol.setDataFromString(framing.data);
  }
  protocol.setOffset(framing.offset ?? 0);
  protocol.setStatus(Status.READY);
  protocol.notify();

  for (let i = 0; i < 20000; i++) {
    const status = protocol.getStatus();
    if (status === Status.SUCCESS || status === Status.ERROR) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("driveFrame timed out waiting for bridge response");
}

/**
 * Issue one operation and drain its (possibly multi-chunk) result, mirroring
 * what a worker-side SyncBackend does: the first frame carries the request and
 * offset 0; continuations carry only the path and the next byte offset.
 */
async function driveAndDrain(
  protocol: ProtocolBuffer,
  opCode: OpCodeType,
  framing: { path?: string; data?: string },
): Promise<{ status: number; text: string }> {
  const first = await driveFrame(protocol, opCode, {
    path: framing.path,
    data: framing.data,
    offset: 0,
  });
  if (first !== Status.SUCCESS) {
    return { status: first, text: protocol.getResultAsString() };
  }

  const total = protocol.getTotalLength();
  const firstChunk = protocol.getResult();
  if (firstChunk.length >= total) {
    return { status: first, text: new TextDecoder().decode(firstChunk) };
  }

  const out = new Uint8Array(total);
  out.set(firstChunk, 0);
  let offset = firstChunk.length;
  while (offset < total) {
    const status = await driveFrame(protocol, opCode, {
      path: framing.path,
      offset,
    });
    if (status !== Status.SUCCESS) {
      return { status, text: protocol.getResultAsString() };
    }
    const chunk = protocol.getResult();
    expect(chunk.length).toBeGreaterThan(0);
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return { status: Status.SUCCESS, text: new TextDecoder().decode(out) };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// READDIR
// ---------------------------------------------------------------------------

/** Directory listing whose JSON serialization is exactly `target` bytes. */
function entriesWithJsonByteLength(target: number): string[] {
  const entries: string[] = [];
  for (let i = 0; i < 2000; i++) {
    entries.push(`file-${String(i).padStart(6, "0")}.txt`);
  }
  const pad = target - byteLength(JSON.stringify(entries)) - 3;
  entries.push("p".repeat(pad));
  return entries;
}

class BigReaddirFs extends InMemoryFs {
  constructor(private readonly entries: string[]) {
    super();
  }
  override async readdir(_path: string): Promise<string[]> {
    return this.entries;
  }
}

// ---------------------------------------------------------------------------
// HTTP_REQUEST
// ---------------------------------------------------------------------------

const HTTP_URL = "https://example.com/big";
const HTTP_HEADERS = { "content-type": "text/plain" };

function httpResultJson(body: string): string {
  return JSON.stringify({
    status: 200,
    statusText: "OK",
    headers: HTTP_HEADERS,
    body,
    url: HTTP_URL,
  });
}

/** HTTP body whose serialized bridge result is exactly `target` bytes. */
function httpBodyForResultLength(target: number): string {
  return "b".repeat(target - byteLength(httpResultJson("")));
}

function fetchReturning(body: string): SecureFetch {
  return async () => ({
    status: 200,
    statusText: "OK",
    headers: HTTP_HEADERS,
    body,
    url: HTTP_URL,
  });
}

// ---------------------------------------------------------------------------
// EXEC_COMMAND
// ---------------------------------------------------------------------------

function execResultJson(stdout: string): string {
  return JSON.stringify({ stdout, stderr: "", exitCode: 0 });
}

/** Command stdout whose serialized bridge result is exactly `target` bytes. */
function execStdoutForResultLength(target: number): string {
  return "s".repeat(target - byteLength(execResultJson("")));
}

function execReturning(
  stdout: string,
): (command: string, options: CommandExecOptions) => Promise<ExecResult> {
  return async () => ({ stdout, stderr: "", exitCode: 0 });
}

// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

const SIZES: Array<{ name: string; size: number }> = [
  { name: "just under the 1MB window", size: MAX_CHUNK_SIZE - 1 },
  { name: "exactly the 1MB window", size: MAX_CHUNK_SIZE },
  { name: "just over the 1MB window", size: MAX_CHUNK_SIZE + 1 },
  { name: "well over the window (3MB + 7)", size: 3 * MB + 7 },
];

describe("worker bridge result chunking — READDIR", () => {
  for (const { name, size } of SIZES) {
    it(`returns a listing ${name} intact`, async () => {
      const entries = entriesWithJsonByteLength(size);
      const expected = JSON.stringify(entries);
      expect(byteLength(expected)).toBe(size);

      const shared = createSharedBuffer();
      const protocol = new ProtocolBuffer(shared);
      const handler = new BridgeHandler(
        shared,
        new BigReaddirFs(entries),
        "/",
        "test-cmd",
      );
      const run = handler.run(60000);

      const got = await driveAndDrain(protocol, OpCode.READDIR, { path: "/d" });
      expect(got.status).toBe(Status.SUCCESS);
      expect(byteLength(got.text)).toBe(size);
      expect(got.text).toBe(expected);

      await driveFrame(protocol, OpCode.EXIT, {});
      await run;
    });
  }
});

describe("worker bridge result chunking — HTTP_REQUEST", () => {
  for (const { name, size } of SIZES) {
    it(`returns a response ${name} intact`, async () => {
      const body = httpBodyForResultLength(size);
      const expected = httpResultJson(body);
      expect(byteLength(expected)).toBe(size);

      const shared = createSharedBuffer();
      const protocol = new ProtocolBuffer(shared);
      const handler = new BridgeHandler(
        shared,
        new InMemoryFs(),
        "/",
        "test-cmd",
        fetchReturning(body),
      );
      const run = handler.run(60000);

      const got = await driveAndDrain(protocol, OpCode.HTTP_REQUEST, {
        path: HTTP_URL,
        data: JSON.stringify({ method: "GET" }),
      });
      expect(got.status).toBe(Status.SUCCESS);
      expect(byteLength(got.text)).toBe(size);
      expect(got.text).toBe(expected);

      await driveFrame(protocol, OpCode.EXIT, {});
      await run;
    });
  }

  it("runs the fetch exactly once across a multi-chunk drain", async () => {
    const body = httpBodyForResultLength(3 * MB);
    let calls = 0;
    const counting: SecureFetch = async () => {
      calls++;
      return {
        status: 200,
        statusText: "OK",
        headers: HTTP_HEADERS,
        body,
        url: HTTP_URL,
      };
    };

    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      counting,
    );
    const run = handler.run(60000);

    const got = await driveAndDrain(protocol, OpCode.HTTP_REQUEST, {
      path: HTTP_URL,
      data: JSON.stringify({ method: "GET" }),
    });
    expect(got.status).toBe(Status.SUCCESS);
    expect(got.text).toBe(httpResultJson(body));
    expect(calls).toBe(1);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });
});

describe("worker bridge result chunking — EXEC_COMMAND", () => {
  for (const { name, size } of SIZES) {
    it(`returns command output ${name} intact`, async () => {
      const stdout = execStdoutForResultLength(size);
      const expected = execResultJson(stdout);
      expect(byteLength(expected)).toBe(size);

      const shared = createSharedBuffer();
      const protocol = new ProtocolBuffer(shared);
      const handler = new BridgeHandler(
        shared,
        new InMemoryFs(),
        "/",
        "test-cmd",
        undefined,
        0,
        execReturning(stdout),
      );
      const run = handler.run(60000);

      const got = await driveAndDrain(protocol, OpCode.EXEC_COMMAND, {
        path: "cat big.txt",
      });
      expect(got.status).toBe(Status.SUCCESS);
      expect(byteLength(got.text)).toBe(size);
      expect(got.text).toBe(expected);

      await driveFrame(protocol, OpCode.EXIT, {});
      await run;
    });
  }

  it("runs the command exactly once across a multi-chunk drain", async () => {
    const stdout = execStdoutForResultLength(3 * MB);
    let calls = 0;
    const counting = async (): Promise<ExecResult> => {
      calls++;
      return { stdout, stderr: "", exitCode: 0 };
    };

    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      undefined,
      0,
      counting,
    );
    const run = handler.run(60000);

    const got = await driveAndDrain(protocol, OpCode.EXEC_COMMAND, {
      path: "cat big.txt",
    });
    expect(got.status).toBe(Status.SUCCESS);
    expect(got.text).toBe(execResultJson(stdout));
    expect(calls).toBe(1);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });
});

// ---------------------------------------------------------------------------
// The remaining hard ceiling must be typed, not generic.
// ---------------------------------------------------------------------------

class HugeReadlinkFs extends InMemoryFs {
  constructor(private readonly value: string) {
    super();
  }
  override async readlink(_path: string): Promise<string> {
    return this.value;
  }
  override async realpath(_path: string): Promise<string> {
    return this.value;
  }
}

describe("worker bridge — the hard size ceiling has its own ErrorCode", () => {
  it("READLINK over the 1MB window reports PAYLOAD_TOO_LARGE, not IO_ERROR", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(
      shared,
      new HugeReadlinkFs("t".repeat(MAX_CHUNK_SIZE + 1)),
      "/",
      "test-cmd",
    );
    const run = handler.run(60000);

    const status = await driveFrame(protocol, OpCode.READLINK, {
      path: "/link",
    });
    expect(status).toBe(Status.ERROR);
    expect(protocol.getErrorCode()).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expect(protocol.getResultAsString()).toContain("too large");

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });

  it("REALPATH over the 1MB window reports PAYLOAD_TOO_LARGE, not IO_ERROR", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(
      shared,
      new HugeReadlinkFs("r".repeat(MAX_CHUNK_SIZE + 1)),
      "/",
      "test-cmd",
    );
    const run = handler.run(60000);

    const status = await driveFrame(protocol, OpCode.REALPATH, {
      path: "/some/path",
    });
    expect(status).toBe(Status.ERROR);
    expect(protocol.getErrorCode()).toBe(ErrorCode.PAYLOAD_TOO_LARGE);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });

  it("an over-cap declared write transfer reports PAYLOAD_TOO_LARGE", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
    );
    const run = handler.run(60000);

    protocol.reset();
    protocol.setOpCode(OpCode.WRITE_FILE);
    protocol.setPath("/huge.bin");
    protocol.setDataChunk(new Uint8Array(10), 0, 1024 * 1024 * 1024, true);
    protocol.setStatus(Status.READY);
    protocol.notify();

    let status = Status.PENDING as number;
    for (let i = 0; i < 20000; i++) {
      const s = protocol.getStatus();
      if (s === Status.SUCCESS || s === Status.ERROR) {
        status = s;
        break;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(status).toBe(Status.ERROR);
    expect(protocol.getErrorCode()).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expect(protocol.getResultAsString()).toContain("too large");

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });

  it("a result continuation with no transfer in flight is rejected without re-running the producer", async () => {
    let calls = 0;
    const counting = async (): Promise<ExecResult> => {
      calls++;
      return { stdout: "x", stderr: "", exitCode: 0 };
    };

    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      undefined,
      0,
      counting,
    );
    const run = handler.run(60000);

    const status = await driveFrame(protocol, OpCode.EXEC_COMMAND, {
      path: "echo hi",
      offset: 4096,
    });
    expect(status).toBe(Status.ERROR);
    expect(calls).toBe(0);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });

  it("a continuation for a different key does not re-run the producer", async () => {
    const body = httpBodyForResultLength(3 * MB);
    let calls = 0;
    const counting: SecureFetch = async () => {
      calls++;
      return {
        status: 200,
        statusText: "OK",
        headers: HTTP_HEADERS,
        body,
        url: HTTP_URL,
      };
    };

    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      counting,
    );
    const run = handler.run(60000);

    // Start a multi-chunk transfer for one URL...
    const first = await driveFrame(protocol, OpCode.HTTP_REQUEST, {
      path: HTTP_URL,
      data: JSON.stringify({ method: "GET" }),
      offset: 0,
    });
    expect(first).toBe(Status.SUCCESS);
    expect(protocol.getMore()).toBe(true);
    expect(calls).toBe(1);

    // ...then send a continuation naming a different URL.
    const stray = await driveFrame(protocol, OpCode.HTTP_REQUEST, {
      path: "https://example.com/other",
      offset: MAX_CHUNK_SIZE,
    });
    expect(stray).toBe(Status.ERROR);
    expect(calls).toBe(1);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });
});

// ---------------------------------------------------------------------------
// Regressions guarded around the relocated producer logic.
// ---------------------------------------------------------------------------

describe("worker bridge result chunking — non-size failures keep their codes", () => {
  it("a genuine fetch failure is still NETWORK_ERROR", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const failing: SecureFetch = async () => {
      throw new Error("connection refused");
    };
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      failing,
    );
    const run = handler.run(60000);

    const status = await driveFrame(protocol, OpCode.HTTP_REQUEST, {
      path: HTTP_URL,
      data: JSON.stringify({ method: "GET" }),
    });
    expect(status).toBe(Status.ERROR);
    expect(protocol.getErrorCode()).toBe(ErrorCode.NETWORK_ERROR);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });

  it("a genuine exec failure is still IO_ERROR", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const failing = async (): Promise<ExecResult> => {
      throw new Error("exec blew up");
    };
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      undefined,
      0,
      failing,
    );
    const run = handler.run(60000);

    const status = await driveFrame(protocol, OpCode.EXEC_COMMAND, {
      path: "boom",
    });
    expect(status).toBe(Status.ERROR);
    expect(protocol.getErrorCode()).toBe(ErrorCode.IO_ERROR);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });

  it("a missing directory is still NOT_FOUND", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
    );
    const run = handler.run(60000);

    const status = await driveFrame(protocol, OpCode.READDIR, {
      path: "/nope",
    });
    expect(status).toBe(Status.ERROR);
    expect(protocol.getErrorCode()).toBe(ErrorCode.NOT_FOUND);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });
});

describe("worker bridge result chunking — snapshot lifecycle", () => {
  it("two sequential requests to the same URL each run the producer", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    let calls = 0;
    const counting: SecureFetch = async () => {
      calls++;
      return {
        status: 200,
        statusText: "OK",
        headers: HTTP_HEADERS,
        body: `call-${calls}`,
        url: HTTP_URL,
      };
    };
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      counting,
    );
    const run = handler.run(60000);

    const one = await driveAndDrain(protocol, OpCode.HTTP_REQUEST, {
      path: HTTP_URL,
      data: JSON.stringify({ method: "GET" }),
    });
    const two = await driveAndDrain(protocol, OpCode.HTTP_REQUEST, {
      path: HTTP_URL,
      data: JSON.stringify({ method: "GET" }),
    });
    expect(one.text).toBe(httpResultJson("call-1"));
    expect(two.text).toBe(httpResultJson("call-2"));
    expect(calls).toBe(2);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });

  it("a multi-chunk drain frees the snapshot so the next request is fresh", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const bigBody = "b".repeat(2 * MB);
    let calls = 0;
    const counting: SecureFetch = async () => {
      calls++;
      return {
        status: 200,
        statusText: "OK",
        headers: HTTP_HEADERS,
        body: `${bigBody}#${calls}`,
        url: HTTP_URL,
      };
    };
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      counting,
    );
    const run = handler.run(60000);

    const one = await driveAndDrain(protocol, OpCode.HTTP_REQUEST, {
      path: HTTP_URL,
      data: JSON.stringify({ method: "GET" }),
    });
    const two = await driveAndDrain(protocol, OpCode.HTTP_REQUEST, {
      path: HTTP_URL,
      data: JSON.stringify({ method: "GET" }),
    });
    expect(one.status).toBe(Status.SUCCESS);
    expect(two.status).toBe(Status.SUCCESS);
    expect(one.text).toBe(httpResultJson(`${bigBody}#1`));
    expect(two.text).toBe(httpResultJson(`${bigBody}#2`));
    expect(calls).toBe(2);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });

  it("EXEC_COMMAND structured args are still shell-joined on the main thread", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const seen: string[] = [];
    const recording = async (command: string): Promise<ExecResult> => {
      seen.push(command);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      undefined,
      0,
      recording,
    );
    const run = handler.run(60000);

    const got = await driveAndDrain(protocol, OpCode.EXEC_COMMAND, {
      path: "echo",
      data: JSON.stringify({ args: ["a b", "; rm -rf /"] }),
    });
    expect(got.status).toBe(Status.SUCCESS);
    expect(got.text).toBe(execResultJson("ok"));
    expect(seen).toEqual(["'echo' 'a b' '; rm -rf /'"]);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });

  it("EXEC_COMMAND stdin is still forwarded", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const seen: Array<string | undefined> = [];
    const recording = async (
      _command: string,
      options: CommandExecOptions,
    ): Promise<ExecResult> => {
      seen.push(options.stdin);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      undefined,
      0,
      recording,
    );
    const run = handler.run(60000);

    const got = await driveAndDrain(protocol, OpCode.EXEC_COMMAND, {
      path: "cat",
      data: JSON.stringify({ stdin: "piped input" }),
    });
    expect(got.status).toBe(Status.SUCCESS);
    expect(seen).toEqual(["piped input"]);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });
});
