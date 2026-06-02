/**
 * Worker-side synchronous backend
 *
 * Runs in the worker thread and makes synchronous calls to the main thread
 * via SharedArrayBuffer + Atomics.
 */

import {
  Flags,
  MAX_CHUNK_SIZE,
  OpCode,
  type OpCodeType,
  ProtocolBuffer,
  Status,
} from "./protocol.js";

/**
 * Synchronous backend for worker threads.
 */
export class SyncBackend {
  private protocol: ProtocolBuffer;
  private operationTimeoutMs: number;

  constructor(sharedBuffer: SharedArrayBuffer, operationTimeoutMs = 30000) {
    this.protocol = new ProtocolBuffer(sharedBuffer);
    this.operationTimeoutMs = operationTimeoutMs;
  }

  /**
   * Send one framed round-trip. Used directly for non-chunked operations and
   * internally by the chunked read/write helpers.
   */
  private execFrame(
    opCode: OpCodeType,
    framing: {
      path: string;
      data?: Uint8Array;
      flags?: number;
      mode?: number;
      offset?: number;
      totalLength?: number;
      more?: boolean;
    },
  ): { success: boolean; result?: Uint8Array; error?: string } {
    this.protocol.reset();
    this.protocol.setOpCode(opCode);
    this.protocol.setPath(framing.path);
    this.protocol.setFlags(framing.flags ?? 0);
    this.protocol.setMode(framing.mode ?? 0);
    if (framing.data) {
      // setDataChunk records offset/total/more even when offset is 0 and there
      // is a single chunk, keeping the main-thread state machine uniform.
      this.protocol.setDataChunk(
        framing.data,
        framing.offset ?? 0,
        framing.totalLength ?? framing.data.length,
        framing.more ?? false,
      );
    } else {
      this.protocol.setOffset(framing.offset ?? 0);
      this.protocol.setTotalLength(framing.totalLength ?? 0);
      this.protocol.setMore(framing.more ?? false);
    }

    this.protocol.setStatus(Status.READY);
    this.protocol.notify();

    // Wait for main thread to process (with timeout)
    const waitResult = this.protocol.waitForResult(this.operationTimeoutMs);
    if (waitResult === "timed-out") {
      return { success: false, error: "Operation timed out" };
    }

    const status = this.protocol.getStatus();
    if (status === Status.SUCCESS) {
      return { success: true, result: this.protocol.getResult() };
    }
    return {
      success: false,
      error:
        this.protocol.getResultAsString() ||
        `Error code: ${this.protocol.getErrorCode()}`,
    };
  }

  private execSync(
    opCode: OpCodeType,
    path: string,
    data?: Uint8Array,
    flags = 0,
    mode = 0,
  ): { success: boolean; result?: Uint8Array; error?: string } {
    return this.execFrame(opCode, { path, data, flags, mode });
  }

  /**
   * Read a file of arbitrary size by draining it from the main thread one
   * <=MAX_CHUNK_SIZE chunk at a time. The first round-trip returns the total
   * payload size; subsequent round-trips request the remaining byte ranges.
   */
  readFile(path: string): Uint8Array {
    const first = this.execFrame(OpCode.READ_FILE, { path, offset: 0 });
    if (!first.success) {
      throw new Error(first.error || "Failed to read file");
    }
    const total = this.protocol.getTotalLength();
    const firstChunk = first.result ?? new Uint8Array(0);
    if (firstChunk.length >= total) {
      return firstChunk;
    }

    const out = new Uint8Array(total);
    out.set(firstChunk, 0);
    let offset = firstChunk.length;
    while (offset < total) {
      const next = this.execFrame(OpCode.READ_FILE, { path, offset });
      if (!next.success) {
        throw new Error(next.error || "Failed to read file");
      }
      const chunk = next.result ?? new Uint8Array(0);
      if (chunk.length === 0) {
        // Defensive: main thread reported no progress; avoid an infinite loop.
        throw new Error("Chunked read stalled: empty chunk before completion");
      }
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  writeFile(path: string, data: Uint8Array): void {
    this.writeChunked(OpCode.WRITE_FILE, path, data);
  }

  /**
   * Write a payload of arbitrary size by streaming it to the main thread one
   * <=MAX_CHUNK_SIZE chunk at a time. The main thread buffers chunks keyed by
   * (opCode, path) and commits to the filesystem only on the final chunk.
   */
  private writeChunked(
    opCode: OpCodeType,
    path: string,
    data: Uint8Array,
  ): void {
    const total = data.length;
    // Even an empty payload needs one round-trip to create/truncate the file.
    let offset = 0;
    do {
      const end = Math.min(offset + MAX_CHUNK_SIZE, total);
      const chunk = data.subarray(offset, end);
      const more = end < total;
      const result = this.execFrame(opCode, {
        path,
        data: chunk,
        offset,
        totalLength: total,
        more,
      });
      if (!result.success) {
        throw new Error(result.error || "Failed to write file");
      }
      offset = end;
    } while (offset < total);
  }

  stat(path: string): {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode: number;
    size: number;
    mtime: Date;
  } {
    const result = this.execSync(OpCode.STAT, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to stat");
    }
    return this.protocol.decodeStat();
  }

  lstat(path: string): {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode: number;
    size: number;
    mtime: Date;
  } {
    const result = this.execSync(OpCode.LSTAT, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to lstat");
    }
    return this.protocol.decodeStat();
  }

  readdir(path: string): string[] {
    const result = this.execSync(OpCode.READDIR, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to readdir");
    }
    return JSON.parse(this.protocol.getResultAsString());
  }

  mkdir(path: string, recursive = false): void {
    const flags = recursive ? Flags.MKDIR_RECURSIVE : 0;
    const result = this.execSync(OpCode.MKDIR, path, undefined, flags);
    if (!result.success) {
      throw new Error(result.error || "Failed to mkdir");
    }
  }

  rm(path: string, recursive = false, force = false): void {
    let flags = 0;
    if (recursive) flags |= Flags.RECURSIVE;
    if (force) flags |= Flags.FORCE;
    const result = this.execSync(OpCode.RM, path, undefined, flags);
    if (!result.success) {
      throw new Error(result.error || "Failed to rm");
    }
  }

  exists(path: string): boolean {
    const result = this.execSync(OpCode.EXISTS, path);
    if (!result.success) {
      return false;
    }
    return result.result?.[0] === 1;
  }

  appendFile(path: string, data: Uint8Array): void {
    this.writeChunked(OpCode.APPEND_FILE, path, data);
  }

  symlink(target: string, linkPath: string): void {
    const targetData = new TextEncoder().encode(target);
    const result = this.execSync(OpCode.SYMLINK, linkPath, targetData);
    if (!result.success) {
      throw new Error(result.error || "Failed to symlink");
    }
  }

  readlink(path: string): string {
    const result = this.execSync(OpCode.READLINK, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to readlink");
    }
    return this.protocol.getResultAsString();
  }

  chmod(path: string, mode: number): void {
    const result = this.execSync(OpCode.CHMOD, path, undefined, 0, mode);
    if (!result.success) {
      throw new Error(result.error || "Failed to chmod");
    }
  }

  realpath(path: string): string {
    const result = this.execSync(OpCode.REALPATH, path);
    if (!result.success) {
      throw new Error(result.error || "Failed to realpath");
    }
    return this.protocol.getResultAsString();
  }

  rename(oldPath: string, newPath: string): void {
    const newPathData = new TextEncoder().encode(newPath);
    const result = this.execSync(OpCode.RENAME, oldPath, newPathData);
    if (!result.success) {
      throw new Error(result.error || "Failed to rename");
    }
  }

  copyFile(src: string, dest: string): void {
    const destData = new TextEncoder().encode(dest);
    const result = this.execSync(OpCode.COPY_FILE, src, destData);
    if (!result.success) {
      throw new Error(result.error || "Failed to copyFile");
    }
  }

  writeStdout(data: string): void {
    const encoded = new TextEncoder().encode(data);
    const result = this.execSync(OpCode.WRITE_STDOUT, "", encoded);
    if (!result.success) {
      throw new Error(result.error || "Failed to write stdout");
    }
  }

  writeStderr(data: string): void {
    const encoded = new TextEncoder().encode(data);
    const result = this.execSync(OpCode.WRITE_STDERR, "", encoded);
    if (!result.success) {
      throw new Error(result.error || "Failed to write stderr");
    }
  }

  exit(code: number): void {
    this.execSync(OpCode.EXIT, "", undefined, code);
  }

  /**
   * Make an HTTP request through the main thread's secureFetch.
   * Returns the response as a parsed object.
   */
  httpRequest(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    url: string;
  } {
    const requestData = options
      ? new TextEncoder().encode(JSON.stringify(options))
      : undefined;
    const result = this.execSync(OpCode.HTTP_REQUEST, url, requestData);
    if (!result.success) {
      throw new Error(result.error || "HTTP request failed");
    }
    const responseJson = new TextDecoder().decode(result.result);
    return JSON.parse(responseJson);
  }

  /**
   * Execute a shell command through the main thread's exec function.
   * Returns the result as { stdout, stderr, exitCode }.
   */
  execCommand(
    command: string,
    stdin?: string,
  ): {
    stdout: string;
    stderr: string;
    exitCode: number;
  } {
    const requestData = stdin
      ? new TextEncoder().encode(JSON.stringify({ stdin }))
      : undefined;
    const result = this.execSync(OpCode.EXEC_COMMAND, command, requestData);
    if (!result.success) {
      throw new Error(result.error || "Command execution failed");
    }
    const responseJson = new TextDecoder().decode(result.result);
    return JSON.parse(responseJson);
  }

  /**
   * Execute a shell command with structured args (shell-escaped on the main thread).
   * Prevents command injection from unsanitized args.
   */
  execCommandArgs(
    command: string,
    args: string[],
  ): {
    stdout: string;
    stderr: string;
    exitCode: number;
  } {
    const requestData = new TextEncoder().encode(JSON.stringify({ args }));
    const result = this.execSync(OpCode.EXEC_COMMAND, command, requestData);
    if (!result.success) {
      throw new Error(result.error || "Command execution failed");
    }
    const responseJson = new TextDecoder().decode(result.result);
    return JSON.parse(responseJson);
  }
}
