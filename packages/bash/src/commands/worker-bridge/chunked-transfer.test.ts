/**
 * Chunked-transfer framing tests for the worker bridge.
 *
 * These exercise the main-thread BridgeHandler against manually-driven protocol
 * frames (the same frames a worker-side SyncBackend would emit). Driving the
 * frames by hand — rather than spawning a real worker that blocks on
 * Atomics.wait — keeps the tests fast, deterministic, and free of the prebuilt
 * worker.js bundles, while still validating the read/write boundary behavior at
 * exactly the cases that used to silently truncate: just-under, exactly-at,
 * just-over, and several-MB payloads.
 */
import { describe, expect, it } from "vitest";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import { BridgeHandler } from "./bridge-handler.js";
import {
  createSharedBuffer,
  MAX_CHUNK_SIZE,
  OpCode,
  type OpCodeType,
  ProtocolBuffer,
  Status,
} from "./protocol.js";

/**
 * Drive a single framed round-trip against a running BridgeHandler and wait for
 * it to set SUCCESS/ERROR. Mirrors what SyncBackend.execFrame does on a worker,
 * minus the blocking Atomics.wait.
 */
async function driveFrame(
  protocol: ProtocolBuffer,
  opCode: OpCodeType,
  framing: {
    path?: string;
    chunk?: Uint8Array;
    offset?: number;
    totalLength?: number;
    more?: boolean;
  },
): Promise<number> {
  protocol.reset();
  protocol.setOpCode(opCode);
  protocol.setPath(framing.path ?? "");
  if (framing.chunk) {
    protocol.setDataChunk(
      framing.chunk,
      framing.offset ?? 0,
      framing.totalLength ?? framing.chunk.length,
      framing.more ?? false,
    );
  } else {
    protocol.setOffset(framing.offset ?? 0);
    protocol.setTotalLength(framing.totalLength ?? 0);
    protocol.setMore(framing.more ?? false);
  }
  protocol.setStatus(Status.READY);
  protocol.notify();

  for (let i = 0; i < 2000; i++) {
    const status = protocol.getStatus();
    if (status === Status.SUCCESS || status === Status.ERROR) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("driveFrame timed out waiting for bridge response");
}

/** Write `data` to `path` via the chunked write protocol. */
async function writeChunked(
  protocol: ProtocolBuffer,
  path: string,
  data: Uint8Array,
  opCode: OpCodeType = OpCode.WRITE_FILE,
): Promise<void> {
  const total = data.length;
  let offset = 0;
  do {
    const end = Math.min(offset + MAX_CHUNK_SIZE, total);
    const chunk = data.subarray(offset, end);
    const status = await driveFrame(protocol, opCode, {
      path,
      chunk,
      offset,
      totalLength: total,
      more: end < total,
    });
    expect(status).toBe(Status.SUCCESS);
    offset = end;
  } while (offset < total);
}

/** Read `path` via the chunked read protocol and reassemble the payload. */
async function readChunked(
  protocol: ProtocolBuffer,
  path: string,
): Promise<Uint8Array> {
  const first = await driveFrame(protocol, OpCode.READ_FILE, {
    path,
    offset: 0,
  });
  expect(first).toBe(Status.SUCCESS);
  const total = protocol.getTotalLength();
  const firstChunk = protocol.getResult();
  if (firstChunk.length >= total) {
    return firstChunk;
  }
  const out = new Uint8Array(total);
  out.set(firstChunk, 0);
  let offset = firstChunk.length;
  while (offset < total) {
    const status = await driveFrame(protocol, OpCode.READ_FILE, {
      path,
      offset,
    });
    expect(status).toBe(Status.SUCCESS);
    const chunk = protocol.getResult();
    expect(chunk.length).toBeGreaterThan(0);
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Deterministic pseudo-random bytes so round-trips are content-verifiable. */
function makeBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let seed = 0x9e3779b9 ^ n;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out[i] = seed & 0xff;
  }
  return out;
}

function setup(): { protocol: ProtocolBuffer; fs: InMemoryFs; run: Promise<unknown> } {
  const shared = createSharedBuffer();
  const protocol = new ProtocolBuffer(shared);
  const fs = new InMemoryFs();
  const handler = new BridgeHandler(shared, fs, "/", "test-cmd");
  const run = handler.run(20000);
  return { protocol, fs, run };
}

const MB = 1024 * 1024;

describe("worker bridge chunked transfer — write boundaries", () => {
  const cases: Array<{ name: string; size: number }> = [
    { name: "empty (0 bytes)", size: 0 },
    { name: "tiny (10 bytes)", size: 10 },
    { name: "just under 1MB", size: MAX_CHUNK_SIZE - 1 },
    { name: "exactly 1MB", size: MAX_CHUNK_SIZE },
    { name: "just over 1MB", size: MAX_CHUNK_SIZE + 1 },
    { name: "2MB", size: 2 * MB },
    { name: "several MB (5MB + 123)", size: 5 * MB + 123 },
  ];

  for (const { name, size } of cases) {
    it(`writes and reads back ${name} without truncation`, async () => {
      const { protocol, fs, run } = setup();
      const data = makeBytes(size);

      await writeChunked(protocol, "/file.bin", data);

      // Verify via the FS directly.
      const onDisk = await fs.readFileBuffer("/file.bin");
      expect(onDisk.length).toBe(size);
      expect(Buffer.from(onDisk).equals(Buffer.from(data))).toBe(true);

      // Verify via the chunked read protocol round-trips identically.
      const readBack = await readChunked(protocol, "/file.bin");
      expect(readBack.length).toBe(size);
      expect(Buffer.from(readBack).equals(Buffer.from(data))).toBe(true);

      // Cleanly terminate the handler loop.
      await driveFrame(protocol, OpCode.EXIT, {});
      await run;
    });
  }
});

describe("worker bridge chunked transfer — append", () => {
  it("appends a multi-MB payload in chunks", async () => {
    const { protocol, fs, run } = setup();
    const head = makeBytes(100);
    await fs.writeFile("/log.bin", head);

    const tail = makeBytes(3 * MB + 7);
    await writeChunked(protocol, "/log.bin", tail, OpCode.APPEND_FILE);

    const onDisk = await fs.readFileBuffer("/log.bin");
    expect(onDisk.length).toBe(head.length + tail.length);
    expect(Buffer.from(onDisk.subarray(0, 100)).equals(Buffer.from(head))).toBe(
      true,
    );
    expect(Buffer.from(onDisk.subarray(100)).equals(Buffer.from(tail))).toBe(
      true,
    );

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });
});

describe("worker bridge chunked transfer — legacy single-shot compatibility", () => {
  it("accepts a legacy write frame with zeroed framing fields", async () => {
    const { protocol, fs, run } = setup();
    const data = makeBytes(500);

    // Simulate an old worker bundle: set DATA via setData (no framing fields).
    protocol.reset();
    protocol.setOpCode(OpCode.WRITE_FILE);
    protocol.setPath("/legacy.bin");
    protocol.setData(data); // does NOT set TOTAL_LENGTH/MORE
    // Belt and suspenders: ensure framing is zeroed like a fresh buffer.
    protocol.setOffset(0);
    protocol.setTotalLength(0);
    protocol.setMore(false);
    protocol.setStatus(Status.READY);
    protocol.notify();

    let status = Status.PENDING as number;
    for (let i = 0; i < 2000; i++) {
      const s = protocol.getStatus();
      if (s === Status.SUCCESS || s === Status.ERROR) {
        status = s;
        break;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(status).toBe(Status.SUCCESS);

    const onDisk = await fs.readFileBuffer("/legacy.bin");
    expect(Buffer.from(onDisk).equals(Buffer.from(data))).toBe(true);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });
});

describe("worker bridge chunked transfer — protocol abuse", () => {
  it("rejects a chunk that overruns the declared total", async () => {
    const { protocol, run } = setup();
    const status = await driveFrame(protocol, OpCode.WRITE_FILE, {
      path: "/bad.bin",
      chunk: makeBytes(100),
      offset: 0,
      totalLength: 50, // chunk (100) > total (50): abuse
      more: false,
    });
    expect(status).toBe(Status.ERROR);
    expect(protocol.getResultAsString()).toContain("overruns");

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });

  it("rejects an out-of-order chunk offset", async () => {
    const { protocol, run } = setup();
    const total = MAX_CHUNK_SIZE + 100;
    // First chunk OK.
    const first = await driveFrame(protocol, OpCode.WRITE_FILE, {
      path: "/oo.bin",
      chunk: makeBytes(MAX_CHUNK_SIZE),
      offset: 0,
      totalLength: total,
      more: true,
    });
    expect(first).toBe(Status.SUCCESS);
    // Second chunk claims a wrong offset.
    const second = await driveFrame(protocol, OpCode.WRITE_FILE, {
      path: "/oo.bin",
      chunk: makeBytes(100),
      offset: MAX_CHUNK_SIZE + 50, // should be MAX_CHUNK_SIZE
      totalLength: total,
      more: false,
    });
    expect(second).toBe(Status.ERROR);
    expect(protocol.getResultAsString()).toContain("out of order");

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });

  it("rejects an absurdly large declared transfer", async () => {
    const { protocol, run } = setup();
    const status = await driveFrame(protocol, OpCode.WRITE_FILE, {
      path: "/huge.bin",
      chunk: makeBytes(10),
      offset: 0,
      totalLength: 1024 * 1024 * 1024, // 1GB > MAX_TRANSFER_BYTES (256MB)
      more: true,
    });
    expect(status).toBe(Status.ERROR);
    expect(protocol.getResultAsString()).toContain("Transfer too large");

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });
});

describe("worker bridge chunked transfer — read serves a stable snapshot", () => {
  it("read continuation chunks come from the cached snapshot, not a re-read", async () => {
    const { protocol, fs, run } = setup();
    const original = makeBytes(MAX_CHUNK_SIZE + 1000);
    await fs.writeFile("/snap.bin", original);

    // First read chunk caches the whole file.
    const first = await driveFrame(protocol, OpCode.READ_FILE, {
      path: "/snap.bin",
      offset: 0,
    });
    expect(first).toBe(Status.SUCCESS);
    const total = protocol.getTotalLength();
    expect(total).toBe(original.length);
    const firstChunk = Uint8Array.from(protocol.getResult());
    expect(firstChunk.length).toBe(MAX_CHUNK_SIZE);

    // Mutate the file mid-transfer.
    await fs.writeFile("/snap.bin", makeBytes(10));

    // Drain the remainder; it must reflect the original snapshot.
    const out = new Uint8Array(total);
    out.set(firstChunk, 0);
    let offset = firstChunk.length;
    while (offset < total) {
      const status = await driveFrame(protocol, OpCode.READ_FILE, {
        path: "/snap.bin",
        offset,
      });
      expect(status).toBe(Status.SUCCESS);
      const chunk = protocol.getResult();
      out.set(chunk, offset);
      offset += chunk.length;
    }
    expect(Buffer.from(out).equals(Buffer.from(original))).toBe(true);

    await driveFrame(protocol, OpCode.EXIT, {});
    await run;
  });
});
