/**
 * SharedArrayBuffer protocol for synchronous worker bridge
 *
 * This protocol enables synchronous filesystem and I/O access from a worker thread
 * (where CPython/Python or QuickJS runs) to the main thread (which has async IFileSystem).
 */

// Type declaration for Atomics.waitAsync (available in Node.js but not in TS lib)
declare global {
  interface Atomics {
    waitAsync(
      typedArray: Int32Array,
      index: number,
      value: number,
      timeout?: number,
    ):
      | { async: false; value: "not-equal" | "timed-out" }
      | { async: true; value: Promise<"ok" | "timed-out"> };
  }
}

/** Operation codes */
export const OpCode = {
  NOOP: 0,
  READ_FILE: 1,
  WRITE_FILE: 2,
  STAT: 3,
  READDIR: 4,
  MKDIR: 5,
  RM: 6,
  EXISTS: 7,
  APPEND_FILE: 8,
  SYMLINK: 9,
  READLINK: 10,
  LSTAT: 11,
  CHMOD: 12,
  REALPATH: 13,
  RENAME: 14,
  COPY_FILE: 15,
  // Special operations for I/O
  WRITE_STDOUT: 100,
  WRITE_STDERR: 101,
  EXIT: 102,
  // HTTP operations
  HTTP_REQUEST: 200,
  // Sub-shell execution
  EXEC_COMMAND: 300,
} as const;

export type OpCodeType = (typeof OpCode)[keyof typeof OpCode];

/** Status codes for synchronization */
export const Status = {
  PENDING: 0,
  READY: 1,
  SUCCESS: 2,
  ERROR: 3,
} as const;

export type StatusType = (typeof Status)[keyof typeof Status];

/** Error codes */
export const ErrorCode = {
  NONE: 0,
  NOT_FOUND: 1,
  IS_DIRECTORY: 2,
  NOT_DIRECTORY: 3,
  EXISTS: 4,
  PERMISSION_DENIED: 5,
  INVALID_PATH: 6,
  IO_ERROR: 7,
  TIMEOUT: 8,
  NETWORK_ERROR: 9,
  NETWORK_NOT_CONFIGURED: 10,
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

// Buffer layout offsets.
//
// IMPORTANT (backward compatibility): the original control-region fields
// (OP_CODE..MODE), PATH_BUFFER, and DATA_BUFFER offsets are LEFT UNCHANGED so
// that prebuilt worker bundles (worker.js) — which embed the old layout — keep
// interoperating with this main-thread protocol for single-shot operations.
// The chunked-transfer framing fields are appended AFTER the 1MB data window
// instead of widening the control region; older workers never read them, and
// newer (rebuilt) workers use them to stream payloads >1MB. This avoids a
// layout mismatch that would corrupt memory across the thread boundary.
const Offset = {
  OP_CODE: 0,
  STATUS: 4,
  PATH_LENGTH: 8,
  DATA_LENGTH: 12,
  RESULT_LENGTH: 16,
  ERROR_CODE: 20,
  FLAGS: 24,
  MODE: 28,
  PATH_BUFFER: 32,
  DATA_BUFFER: 4128, // 32 + 4096 (unchanged)
  // Chunked transfer framing (added v6.0.0) — appended after the data window.
  // OFFSET is the byte position of the current chunk within the logical
  // payload; TOTAL_LENGTH is the full payload size; MORE is a 0/1 flag set by
  // the producer when more chunks follow. 4128 + 1048576 = 1052704.
  OFFSET: 1052704,
  TOTAL_LENGTH: 1052708,
  MORE: 1052712,
} as const;

/** Buffer sizes */
const Size = {
  CONTROL_REGION: 32,
  PATH_BUFFER: 4096,
  // The data window is 1MB. Payloads larger than this are NOT truncated:
  // read/write split them into <=DATA_BUFFER chunks and stream them across
  // multiple synchronous round-trips via the chunked transfer framing
  // (see Offset.OFFSET / TOTAL_LENGTH / MORE). DATA_BUFFER therefore bounds the
  // per-round-trip window, not the maximum file size. Kept at 1MB for fast
  // tests; raising it trades memory for fewer round-trips on large files.
  DATA_BUFFER: 1048576,
  // Maximum bytes moved in a single chunk (== the data window size).
  MAX_CHUNK: 1048576,
  // 32 (control) + 4096 (path) + 1MB (data) + 12 (3 framing int32s) = 1052716.
  TOTAL: 1052716,
} as const;

/** Maximum bytes that can be moved in a single chunked round-trip. */
export const MAX_CHUNK_SIZE: number = Size.MAX_CHUNK;

/** Flags for operations */
export const Flags = {
  NONE: 0,
  RECURSIVE: 1,
  FORCE: 2,
  MKDIR_RECURSIVE: 1,
} as const;

/** Stat result structure layout */
const StatLayout = {
  IS_FILE: 0,
  IS_DIRECTORY: 1,
  IS_SYMLINK: 2,
  MODE: 4,
  SIZE: 8,
  MTIME: 16,
  TOTAL: 24,
} as const;

/** Create a new SharedArrayBuffer for the protocol */
import {
  _Atomics,
  _SharedArrayBuffer,
} from "../../security/trusted-globals.js";
export function createSharedBuffer(): SharedArrayBuffer {
  return new _SharedArrayBuffer(Size.TOTAL);
}

/**
 * Helper class for reading/writing protocol data
 */
export class ProtocolBuffer {
  private int32View: Int32Array;
  private uint8View: Uint8Array;
  private dataView: DataView;

  constructor(buffer: SharedArrayBuffer) {
    this.int32View = new Int32Array(buffer);
    this.uint8View = new Uint8Array(buffer);
    this.dataView = new DataView(buffer);
  }

  getOpCode(): OpCodeType {
    return _Atomics.load(this.int32View, Offset.OP_CODE / 4) as OpCodeType;
  }

  setOpCode(code: OpCodeType): void {
    _Atomics.store(this.int32View, Offset.OP_CODE / 4, code);
  }

  getStatus(): StatusType {
    return _Atomics.load(this.int32View, Offset.STATUS / 4) as StatusType;
  }

  setStatus(status: StatusType): void {
    _Atomics.store(this.int32View, Offset.STATUS / 4, status);
  }

  getPathLength(): number {
    return _Atomics.load(this.int32View, Offset.PATH_LENGTH / 4);
  }

  setPathLength(length: number): void {
    _Atomics.store(this.int32View, Offset.PATH_LENGTH / 4, length);
  }

  getDataLength(): number {
    return _Atomics.load(this.int32View, Offset.DATA_LENGTH / 4);
  }

  setDataLength(length: number): void {
    _Atomics.store(this.int32View, Offset.DATA_LENGTH / 4, length);
  }

  getResultLength(): number {
    return _Atomics.load(this.int32View, Offset.RESULT_LENGTH / 4);
  }

  setResultLength(length: number): void {
    _Atomics.store(this.int32View, Offset.RESULT_LENGTH / 4, length);
  }

  getErrorCode(): ErrorCodeType {
    return _Atomics.load(
      this.int32View,
      Offset.ERROR_CODE / 4,
    ) as ErrorCodeType;
  }

  setErrorCode(code: ErrorCodeType): void {
    _Atomics.store(this.int32View, Offset.ERROR_CODE / 4, code);
  }

  getFlags(): number {
    return _Atomics.load(this.int32View, Offset.FLAGS / 4);
  }

  setFlags(flags: number): void {
    _Atomics.store(this.int32View, Offset.FLAGS / 4, flags);
  }

  getMode(): number {
    return _Atomics.load(this.int32View, Offset.MODE / 4);
  }

  setMode(mode: number): void {
    _Atomics.store(this.int32View, Offset.MODE / 4, mode);
  }

  /** Byte offset of the current chunk within the logical payload. */
  getOffset(): number {
    return _Atomics.load(this.int32View, Offset.OFFSET / 4);
  }

  setOffset(offset: number): void {
    _Atomics.store(this.int32View, Offset.OFFSET / 4, offset);
  }

  /** Total size of the logical (possibly multi-chunk) payload, in bytes. */
  getTotalLength(): number {
    return _Atomics.load(this.int32View, Offset.TOTAL_LENGTH / 4);
  }

  setTotalLength(length: number): void {
    _Atomics.store(this.int32View, Offset.TOTAL_LENGTH / 4, length);
  }

  /** True when more chunks follow the current one. */
  getMore(): boolean {
    return _Atomics.load(this.int32View, Offset.MORE / 4) === 1;
  }

  setMore(more: boolean): void {
    _Atomics.store(this.int32View, Offset.MORE / 4, more ? 1 : 0);
  }

  getPath(): string {
    const length = this.getPathLength();
    const bytes = this.uint8View.slice(
      Offset.PATH_BUFFER,
      Offset.PATH_BUFFER + length,
    );
    return new TextDecoder().decode(bytes);
  }

  setPath(path: string): void {
    const encoded = new TextEncoder().encode(path);
    if (encoded.length > Size.PATH_BUFFER) {
      throw new Error(`Path too long: ${encoded.length} > ${Size.PATH_BUFFER}`);
    }
    this.uint8View.set(encoded, Offset.PATH_BUFFER);
    this.setPathLength(encoded.length);
  }

  getData(): Uint8Array {
    const length = this.getDataLength();
    return this.uint8View.slice(
      Offset.DATA_BUFFER,
      Offset.DATA_BUFFER + length,
    );
  }

  setData(data: Uint8Array): void {
    if (data.length > Size.DATA_BUFFER) {
      throw new Error(`Data too large: ${data.length} > ${Size.DATA_BUFFER}`);
    }
    this.uint8View.set(data, Offset.DATA_BUFFER);
    this.setDataLength(data.length);
  }

  /**
   * Write one chunk of an outbound (worker -> main) payload into the data
   * window, recording its position via the chunked-transfer framing fields.
   * `chunk` must already be a slice that fits in the data window.
   */
  setDataChunk(
    chunk: Uint8Array,
    offset: number,
    totalLength: number,
    more: boolean,
  ): void {
    if (chunk.length > Size.MAX_CHUNK) {
      throw new Error(`Chunk too large: ${chunk.length} > ${Size.MAX_CHUNK}`);
    }
    this.uint8View.set(chunk, Offset.DATA_BUFFER);
    this.setDataLength(chunk.length);
    this.setOffset(offset);
    this.setTotalLength(totalLength);
    this.setMore(more);
  }

  getDataAsString(): string {
    const data = this.getData();
    return new TextDecoder().decode(data);
  }

  setDataFromString(str: string): void {
    const encoded = new TextEncoder().encode(str);
    this.setData(encoded);
  }

  getResult(): Uint8Array {
    const length = this.getResultLength();
    return this.uint8View.slice(
      Offset.DATA_BUFFER,
      Offset.DATA_BUFFER + length,
    );
  }

  setResult(data: Uint8Array): void {
    if (data.length > Size.DATA_BUFFER) {
      throw new Error(`Result too large: ${data.length} > ${Size.DATA_BUFFER}`);
    }
    this.uint8View.set(data, Offset.DATA_BUFFER);
    this.setResultLength(data.length);
  }

  /**
   * Write one chunk of an inbound (main -> worker) result into the data window,
   * recording its position via the chunked-transfer framing fields. `chunk`
   * must already be a slice that fits in the data window.
   */
  setResultChunk(
    chunk: Uint8Array,
    offset: number,
    totalLength: number,
    more: boolean,
  ): void {
    if (chunk.length > Size.MAX_CHUNK) {
      throw new Error(`Chunk too large: ${chunk.length} > ${Size.MAX_CHUNK}`);
    }
    this.uint8View.set(chunk, Offset.DATA_BUFFER);
    this.setResultLength(chunk.length);
    this.setOffset(offset);
    this.setTotalLength(totalLength);
    this.setMore(more);
  }

  getResultAsString(): string {
    const result = this.getResult();
    return new TextDecoder().decode(result);
  }

  setResultFromString(str: string): void {
    const encoded = new TextEncoder().encode(str);
    this.setResult(encoded);
  }

  encodeStat(stat: {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode: number;
    size: number;
    mtime: Date;
  }): void {
    this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_FILE] = stat.isFile
      ? 1
      : 0;
    this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_DIRECTORY] =
      stat.isDirectory ? 1 : 0;
    this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_SYMLINK] =
      stat.isSymbolicLink ? 1 : 0;
    this.dataView.setInt32(
      Offset.DATA_BUFFER + StatLayout.MODE,
      stat.mode,
      true,
    );
    const size = Math.min(stat.size, Number.MAX_SAFE_INTEGER);
    this.dataView.setFloat64(Offset.DATA_BUFFER + StatLayout.SIZE, size, true);
    this.dataView.setFloat64(
      Offset.DATA_BUFFER + StatLayout.MTIME,
      stat.mtime.getTime(),
      true,
    );
    this.setResultLength(StatLayout.TOTAL);
  }

  decodeStat(): {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode: number;
    size: number;
    mtime: Date;
  } {
    return {
      isFile: this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_FILE] === 1,
      isDirectory:
        this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_DIRECTORY] === 1,
      isSymbolicLink:
        this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_SYMLINK] === 1,
      mode: this.dataView.getInt32(Offset.DATA_BUFFER + StatLayout.MODE, true),
      size: this.dataView.getFloat64(
        Offset.DATA_BUFFER + StatLayout.SIZE,
        true,
      ),
      mtime: new Date(
        this.dataView.getFloat64(Offset.DATA_BUFFER + StatLayout.MTIME, true),
      ),
    };
  }

  waitForReady(timeout?: number): "ok" | "timed-out" | "not-equal" {
    return _Atomics.wait(
      this.int32View,
      Offset.STATUS / 4,
      Status.PENDING,
      timeout,
    );
  }

  waitForReadyAsync(
    timeout?: number,
  ):
    | { async: false; value: "not-equal" | "timed-out" }
    | { async: true; value: Promise<"ok" | "timed-out"> } {
    // Wait for status to change from PENDING (any change means worker set READY)
    return _Atomics.waitAsync(
      this.int32View,
      Offset.STATUS / 4,
      Status.PENDING,
      timeout,
    );
  }

  /**
   * Wait for status to become READY.
   * Returns immediately if status is already READY, or waits until it changes.
   */
  async waitUntilReady(timeout: number): Promise<boolean> {
    const startTime = Date.now();

    while (true) {
      const status = this.getStatus();
      if (status === Status.READY) {
        return true;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= timeout) {
        return false;
      }

      // Wait for any status change
      const remainingMs = timeout - elapsed;
      const result = _Atomics.waitAsync(
        this.int32View,
        Offset.STATUS / 4,
        status,
        remainingMs,
      );

      if (result.async) {
        const waitResult = await result.value;
        if (waitResult === "timed-out") {
          return false;
        }
      }
      // Re-check status after wait
    }
  }

  waitForResult(timeout?: number): "ok" | "timed-out" | "not-equal" {
    return _Atomics.wait(
      this.int32View,
      Offset.STATUS / 4,
      Status.READY,
      timeout,
    );
  }

  notify(): number {
    return _Atomics.notify(this.int32View, Offset.STATUS / 4);
  }

  reset(): void {
    this.setOpCode(OpCode.NOOP);
    this.setStatus(Status.PENDING);
    this.setPathLength(0);
    this.setDataLength(0);
    this.setResultLength(0);
    this.setErrorCode(ErrorCode.NONE);
    this.setFlags(Flags.NONE);
    this.setMode(0);
    this.setOffset(0);
    this.setTotalLength(0);
    this.setMore(false);
  }
}
