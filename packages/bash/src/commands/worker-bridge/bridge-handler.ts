/**
 * Main thread bridge handler
 *
 * Runs on the main thread and processes filesystem, I/O, HTTP, and exec
 * requests from a worker thread via SharedArrayBuffer + Atomics.
 */

import type { IFileSystem } from "../../fs/interface.js";
import { sanitizeErrorMessage } from "../../fs/real-fs-utils.js";
import { shellJoinArgs } from "../../helpers/shell-quote.js";
import type { SecureFetch } from "../../network/fetch.js";
import { _clearTimeout, _setTimeout } from "../../timers.js";
import type { CommandExecOptions, ExecResult } from "../../types.js";
import {
  ErrorCode,
  type ErrorCodeType,
  Flags,
  MAX_CHUNK_SIZE,
  OpCode,
  type OpCodeType,
  PayloadTooLargeError,
  ProtocolBuffer,
  Status,
} from "./protocol.js";

export interface BridgeOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Hard cap on a single chunked transfer (read or write) through the bridge.
 * Bounds memory a single (possibly malicious) worker can force the main thread
 * to buffer. 256MB is generous for legitimate file workloads while preventing
 * an OOM via an absurd TOTAL_LENGTH claim.
 */
const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;

/** In-progress accumulation of a chunked write/append payload. */
interface WriteAccumulator {
  opCode: OpCodeType;
  path: string;
  total: number;
  received: number;
  buffer: Uint8Array;
}

/**
 * Snapshot of a result being served across multiple chunked round-trips, keyed
 * by the operation and its subject (path / URL / command) so a continuation
 * frame can be matched to the transfer it belongs to.
 */
interface ResultCacheEntry {
  opCode: OpCodeType;
  key: string;
  data: Uint8Array;
}

/**
 * Handles requests from a worker thread.
 */
export class BridgeHandler {
  private protocol: ProtocolBuffer;
  private running = false;
  private output: BridgeOutput = { stdout: "", stderr: "", exitCode: 0 };
  private outputLimitExceeded = false;
  private startTime = 0;
  private timeoutMs = 0;
  // Chunked-transfer state. Only one transfer of each kind is in flight at a
  // time because the worker bridge is strictly synchronous (one round-trip per
  // loop iteration), so a single slot each is sufficient.
  private writeAccumulator: WriteAccumulator | null = null;
  private resultCache: ResultCacheEntry | null = null;

  constructor(
    sharedBuffer: SharedArrayBuffer,
    private fs: IFileSystem,
    private cwd: string,
    private commandName: string,
    private secureFetch: SecureFetch | undefined = undefined,
    private maxOutputSize = 0,
    private exec:
      | ((command: string, options: CommandExecOptions) => Promise<ExecResult>)
      | undefined = undefined,
  ) {
    this.protocol = new ProtocolBuffer(sharedBuffer);
  }

  /**
   * Returns remaining milliseconds before the overall execution deadline.
   */
  private remainingMs(): number {
    return Math.max(0, this.timeoutMs - (Date.now() - this.startTime));
  }

  /**
   * Races a promise against the remaining execution deadline.
   * If the deadline expires first, sets `this.running = false` and rejects.
   */
  private raceDeadline<T>(fn: () => Promise<T>): Promise<T> {
    const remaining = this.remainingMs();
    if (remaining <= 0) {
      this.running = false;
      this.output.exitCode = 124;
      this.output.stderr += `\n${this.commandName}: execution timeout exceeded\n`;
      return Promise.reject(new Error("Operation timed out"));
    }
    const promise = fn();
    return new Promise<T>((resolve, reject) => {
      const timer = _setTimeout(() => {
        this.running = false;
        this.output.exitCode = 124;
        this.output.stderr += `\n${this.commandName}: execution timeout exceeded\n`;
        reject(new Error("Operation timed out"));
      }, remaining);
      promise.then(
        (v) => {
          _clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          _clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /**
   * Run the handler loop until EXIT operation or timeout.
   */
  async run(timeoutMs: number): Promise<BridgeOutput> {
    this.running = true;
    this.startTime = Date.now();
    this.timeoutMs = timeoutMs;

    while (this.running) {
      const elapsed = Date.now() - this.startTime;
      if (elapsed >= timeoutMs) {
        this.output.stderr += `\n${this.commandName}: execution timeout exceeded\n`;
        this.output.exitCode = 124;
        break;
      }

      // Wait for worker to set status to READY
      const remainingMs = this.remainingMs();
      const ready = await this.protocol.waitUntilReady(remainingMs);
      if (!ready) {
        this.output.stderr += `\n${this.commandName}: execution timeout exceeded\n`;
        this.output.exitCode = 124;
        break;
      }

      const opCode = this.protocol.getOpCode();
      await this.handleOperation(opCode);

      // handleOperation sets status to SUCCESS/ERROR
      // Notify worker so it wakes up and sees the result
      this.protocol.notify();
    }

    return this.output;
  }

  stop(): void {
    this.running = false;
  }

  /**
   * Returns current captured output.
   */
  getOutput(): BridgeOutput {
    return { ...this.output };
  }

  private async handleOperation(opCode: OpCodeType): Promise<void> {
    try {
      switch (opCode) {
        case OpCode.READ_FILE:
          await this.handleReadFile();
          break;
        case OpCode.WRITE_FILE:
          await this.handleWriteFile();
          break;
        case OpCode.STAT:
          await this.handleStat();
          break;
        case OpCode.LSTAT:
          await this.handleLstat();
          break;
        case OpCode.READDIR:
          await this.handleReaddir();
          break;
        case OpCode.MKDIR:
          await this.handleMkdir();
          break;
        case OpCode.RM:
          await this.handleRm();
          break;
        case OpCode.EXISTS:
          await this.handleExists();
          break;
        case OpCode.APPEND_FILE:
          await this.handleAppendFile();
          break;
        case OpCode.SYMLINK:
          await this.handleSymlink();
          break;
        case OpCode.READLINK:
          await this.handleReadlink();
          break;
        case OpCode.CHMOD:
          await this.handleChmod();
          break;
        case OpCode.REALPATH:
          await this.handleRealpath();
          break;
        case OpCode.RENAME:
          await this.handleRename();
          break;
        case OpCode.COPY_FILE:
          await this.handleCopyFile();
          break;
        case OpCode.WRITE_STDOUT:
          this.handleWriteStdout();
          break;
        case OpCode.WRITE_STDERR:
          this.handleWriteStderr();
          break;
        case OpCode.EXIT:
          this.handleExit();
          break;
        case OpCode.HTTP_REQUEST:
          await this.handleHttpRequest();
          break;
        case OpCode.EXEC_COMMAND:
          await this.handleExecCommand();
          break;
        default:
          this.protocol.setErrorCode(ErrorCode.IO_ERROR);
          this.protocol.setStatus(Status.ERROR);
      }
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private resolvePath(path: string): string {
    return this.fs.resolvePath(this.cwd, path);
  }

  /**
   * Serve one chunk of a (possibly multi-chunk) result.
   *
   * `produce` runs only when a transfer starts (offset 0), and the payload it
   * returns is snapshotted so continuation frames serve a stable view even if
   * the underlying source changes mid-transfer. A continuation never re-runs
   * `produce` — that is what makes this safe for the side-effecting producers
   * (an HTTP fetch, a sub-shell exec): re-running one to satisfy a stray
   * continuation would duplicate the request.
   *
   * `restartable` is for idempotent producers only (file reads): it lets a
   * continuation whose transfer was dropped re-snapshot instead of failing,
   * preserving the pre-existing READ_FILE behaviour.
   */
  private async serveChunkedResult(
    opCode: OpCodeType,
    key: string,
    produce: () => Promise<Uint8Array>,
    restartable = false,
  ): Promise<void> {
    const offset = this.protocol.getOffset();
    let entry = this.resultCache;
    if (entry !== null && (entry.opCode !== opCode || entry.key !== key)) {
      entry = null;
    }

    if (offset === 0 || entry === null) {
      if (offset !== 0 && !restartable) {
        throw new Error(
          "Chunked result continuation has no transfer in flight",
        );
      }
      const data = await produce();
      if (data.length > MAX_TRANSFER_BYTES) {
        this.resultCache = null;
        throw new PayloadTooLargeError(
          "Transfer",
          data.length,
          MAX_TRANSFER_BYTES,
        );
      }
      entry = { opCode, key, data };
      this.resultCache = entry;
    }

    const total = entry.data.length;
    if (offset > total) {
      throw new Error("Chunked result offset out of range");
    }
    const end = Math.min(offset + MAX_CHUNK_SIZE, total);
    const more = end < total;
    this.protocol.setResultChunk(
      entry.data.subarray(offset, end),
      offset,
      total,
      more,
    );
    this.protocol.setStatus(Status.SUCCESS);
    // Free the snapshot once the worker has drained the final chunk.
    if (!more) {
      this.resultCache = null;
    }
  }

  private async handleReadFile(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      await this.serveChunkedResult(
        OpCode.READ_FILE,
        path,
        () => this.fs.readFileBuffer(path),
        true,
      );
    } catch (e) {
      this.resultCache = null;
      this.setErrorFromException(e);
    }
  }

  /**
   * Accumulate a chunked write/append payload. Returns the fully-assembled
   * buffer when the final chunk arrives, or null if more chunks are expected
   * (in which case SUCCESS has already been set). Throws on protocol abuse.
   */
  private accumulateChunkedPayload(
    opCode: OpCodeType,
    path: string,
  ): Uint8Array | null {
    const offset = this.protocol.getOffset();
    const total = this.protocol.getTotalLength();
    const more = this.protocol.getMore();
    const chunk = this.protocol.getData();

    // Legacy / single-shot compatibility: prebuilt worker bundles that predate
    // chunked transfer set DATA_LENGTH but leave the framing fields at exactly
    // zero (a fresh SharedArrayBuffer is zero-initialized and legacy workers
    // never touch them). The chunked protocol always sets TOTAL_LENGTH to the
    // full payload size (>= the chunk length, and == 0 only for an empty
    // payload whose chunk is also empty). So a frame with TOTAL_LENGTH == 0 but
    // a non-empty chunk can only be a legacy single-shot write — treat the
    // chunk as the complete payload. A frame that declares a NON-zero total
    // smaller than its chunk is protocol abuse and falls through to validation.
    if (total === 0 && offset === 0 && !more && chunk.length > 0) {
      this.writeAccumulator = null;
      return chunk;
    }

    if (total < 0 || total > MAX_TRANSFER_BYTES) {
      throw new PayloadTooLargeError("Transfer", total, MAX_TRANSFER_BYTES);
    }

    if (offset === 0) {
      // Start (or restart) accumulation for this payload.
      this.writeAccumulator = {
        opCode,
        path,
        total,
        received: 0,
        buffer: new Uint8Array(total),
      };
    }

    const acc = this.writeAccumulator;
    if (
      !acc ||
      acc.opCode !== opCode ||
      acc.path !== path ||
      acc.total !== total
    ) {
      throw new Error("Chunked write framing mismatch");
    }
    if (offset !== acc.received) {
      throw new Error("Chunked write out of order");
    }
    if (offset + chunk.length > total) {
      throw new Error("Chunked write overruns declared total");
    }

    acc.buffer.set(chunk, offset);
    acc.received += chunk.length;

    if (more) {
      // Intermediate chunk buffered; nothing committed yet.
      this.protocol.setStatus(Status.SUCCESS);
      return null;
    }

    if (acc.received !== total) {
      throw new Error("Chunked write incomplete on final chunk");
    }
    this.writeAccumulator = null;
    return acc.buffer;
  }

  private async handleWriteFile(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const payload = this.accumulateChunkedPayload(OpCode.WRITE_FILE, path);
      if (payload === null) {
        return;
      }
      await this.fs.writeFile(path, payload);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.writeAccumulator = null;
      this.setErrorFromException(e);
    }
  }

  private async handleStat(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const stat = await this.fs.stat(path);
      this.protocol.encodeStat(stat);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleLstat(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const stat = await this.fs.lstat(path);
      this.protocol.encodeStat(stat);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleReaddir(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      // A directory listing can serialize to more than the 1MB data window, so
      // it is streamed like a file read rather than rejected. Not restartable:
      // re-reading the directory mid-drain could splice two different listings
      // together, and a stray continuation is protocol abuse, not a real case.
      await this.serveChunkedResult(OpCode.READDIR, path, async () => {
        const entries = await this.fs.readdir(path);
        return new TextEncoder().encode(JSON.stringify(entries));
      });
    } catch (e) {
      this.resultCache = null;
      this.setErrorFromException(e);
    }
  }

  private async handleMkdir(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    const flags = this.protocol.getFlags();
    const recursive = (flags & Flags.MKDIR_RECURSIVE) !== 0;
    try {
      await this.fs.mkdir(path, { recursive });
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleRm(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    const flags = this.protocol.getFlags();
    const recursive = (flags & Flags.RECURSIVE) !== 0;
    const force = (flags & Flags.FORCE) !== 0;
    try {
      await this.fs.rm(path, { recursive, force });
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleExists(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const exists = await this.fs.exists(path);
      this.protocol.setResult(new Uint8Array([exists ? 1 : 0]));
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleAppendFile(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const payload = this.accumulateChunkedPayload(OpCode.APPEND_FILE, path);
      if (payload === null) {
        return;
      }
      await this.fs.appendFile(path, payload);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.writeAccumulator = null;
      this.setErrorFromException(e);
    }
  }

  private async handleSymlink(): Promise<void> {
    const path = this.protocol.getPath();
    const data = this.protocol.getDataAsString();
    const linkPath = this.resolvePath(path);
    try {
      await this.fs.symlink(data, linkPath);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleReadlink(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const target = await this.fs.readlink(path);
      this.protocol.setResultFromString(target);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleChmod(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    const mode = this.protocol.getMode();
    try {
      await this.fs.chmod(path, mode);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleRealpath(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const realpath = await this.fs.realpath(path);
      this.protocol.setResultFromString(realpath);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleRename(): Promise<void> {
    const oldPath = this.resolvePath(this.protocol.getPath());
    const newPath = this.resolvePath(this.protocol.getDataAsString());
    try {
      await this.fs.mv(oldPath, newPath);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleCopyFile(): Promise<void> {
    const src = this.resolvePath(this.protocol.getPath());
    const dest = this.resolvePath(this.protocol.getDataAsString());
    try {
      await this.fs.cp(src, dest);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private handleWriteStdout(): void {
    const data = this.protocol.getDataAsString();
    if (!this.tryAppendOutput("stdout", data)) {
      this.outputLimitExceeded = true;
      this.output.exitCode = 1;
      this.appendOutputLimitError();
      this.protocol.setErrorCode(ErrorCode.IO_ERROR);
      this.protocol.setResultFromString("Output size limit exceeded");
      this.protocol.setStatus(Status.ERROR);
      return;
    }
    this.protocol.setStatus(Status.SUCCESS);
  }

  private handleWriteStderr(): void {
    const data = this.protocol.getDataAsString();
    if (!this.tryAppendOutput("stderr", data)) {
      this.outputLimitExceeded = true;
      this.output.exitCode = 1;
      this.appendOutputLimitError();
      this.protocol.setErrorCode(ErrorCode.IO_ERROR);
      this.protocol.setResultFromString("Output size limit exceeded");
      this.protocol.setStatus(Status.ERROR);
      return;
    }
    this.protocol.setStatus(Status.SUCCESS);
  }

  private handleExit(): void {
    const exitCode = this.protocol.getFlags();
    if (!this.outputLimitExceeded) {
      this.output.exitCode = exitCode;
    } else if (this.output.exitCode === 0) {
      this.output.exitCode = 1;
    }
    this.protocol.setStatus(Status.SUCCESS);
    this.running = false;
  }

  private tryAppendOutput(stream: "stdout" | "stderr", data: string): boolean {
    if (this.outputLimitExceeded) {
      return false;
    }

    if (this.maxOutputSize <= 0) {
      if (stream === "stdout") {
        this.output.stdout += data;
      } else {
        this.output.stderr += data;
      }
      return true;
    }

    const total = this.output.stdout.length + this.output.stderr.length;
    if (total + data.length > this.maxOutputSize) {
      return false;
    }

    if (stream === "stdout") {
      this.output.stdout += data;
    } else {
      this.output.stderr += data;
    }
    return true;
  }

  private appendOutputLimitError(): void {
    if (this.maxOutputSize <= 0) {
      return;
    }

    const fullMsg = `${this.commandName}: total output size exceeded (>${this.maxOutputSize} bytes), increase executionLimits.maxOutputSize\n`;
    const msg =
      fullMsg.length > this.maxOutputSize
        ? fullMsg.slice(0, this.maxOutputSize)
        : fullMsg;
    if (this.output.stderr.includes("total output size exceeded")) {
      return;
    }

    const currentTotal = this.output.stdout.length + this.output.stderr.length;
    const needed = currentTotal + msg.length - this.maxOutputSize;
    if (needed > 0) {
      if (this.output.stdout.length >= needed) {
        this.output.stdout = this.output.stdout.slice(
          0,
          this.output.stdout.length - needed,
        );
      } else {
        const remainingNeeded = needed - this.output.stdout.length;
        this.output.stdout = "";
        if (remainingNeeded >= this.output.stderr.length) {
          this.output.stderr = "";
        } else {
          this.output.stderr = this.output.stderr.slice(
            0,
            this.output.stderr.length - remainingNeeded,
          );
        }
      }
    }
    this.output.stderr += msg;
  }

  private async handleHttpRequest(): Promise<void> {
    const fetchFn = this.secureFetch;
    if (!fetchFn) {
      this.protocol.setErrorCode(ErrorCode.NETWORK_NOT_CONFIGURED);
      this.protocol.setResultFromString(
        "Network access not configured. Enable network in Bash options.",
      );
      this.protocol.setStatus(Status.ERROR);
      return;
    }

    const url = this.protocol.getPath();

    try {
      // A response body larger than the 1MB data window is streamed rather than
      // rejected — the deliberate bound on response size is the network layer's
      // `maxResponseSize` (10MB by default), not this framing window. The fetch
      // runs only on the offset-0 frame, so draining never re-issues it.
      await this.serveChunkedResult(OpCode.HTTP_REQUEST, url, async () => {
        const requestJson = this.protocol.getDataAsString();
        // @banned-pattern-ignore: fallback default for HTTP options, accessed only by known keys below
        const request = requestJson ? JSON.parse(requestJson) : {};
        // Cap fetch to the remaining execution deadline via raceDeadline
        // (secureFetch uses AbortController internally for its timeoutMs,
        // but raceDeadline guarantees we don't hang if it never settles).
        const remaining = this.remainingMs();
        const result = await this.raceDeadline(() =>
          fetchFn(url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            timeoutMs: remaining,
          }),
        );

        // Return response as JSON
        return new TextEncoder().encode(
          JSON.stringify({
            status: result.status,
            statusText: result.statusText,
            headers: result.headers,
            body: result.body,
            url: result.url,
          }),
        );
      });
    } catch (e) {
      this.resultCache = null;
      const message = sanitizeErrorMessage(
        e instanceof Error ? e.message : String(e),
      );
      // A size-ceiling failure is NOT a network failure: reporting it as
      // NETWORK_ERROR made "your response was too big" indistinguishable from
      // "the request failed".
      this.protocol.setErrorCode(
        this.sizeAwareErrorCode(e, ErrorCode.NETWORK_ERROR),
      );
      this.protocol.setResultFromString(message);
      this.protocol.setStatus(Status.ERROR);
    }
  }

  private async handleExecCommand(): Promise<void> {
    const execFn = this.exec;
    if (!execFn) {
      this.protocol.setErrorCode(ErrorCode.IO_ERROR);
      this.protocol.setResultFromString(
        "Command execution not available in this context.",
      );
      this.protocol.setStatus(Status.ERROR);
      return;
    }

    const requestedCommand = this.protocol.getPath();

    // Cap exec to the remaining execution deadline via AbortSignal + raceDeadline.
    // AbortSignal provides cooperative cancellation; raceDeadline guarantees
    // we don't hang if exec never respects the signal.
    const controller = new AbortController();
    try {
      // Command output larger than the 1MB data window is streamed rather than
      // rejected. The command runs only on the offset-0 frame, so draining a
      // multi-chunk result never re-executes it.
      await this.serveChunkedResult(
        OpCode.EXEC_COMMAND,
        requestedCommand,
        async () => {
          let command = requestedCommand;
          const dataStr = this.protocol.getDataAsString();
          const options: CommandExecOptions = {
            cwd: this.cwd,
            signal: controller.signal,
          };
          if (dataStr) {
            const parsed = JSON.parse(dataStr);
            if (parsed.stdin) {
              options.stdin = parsed.stdin;
            }
            // Structured args (spawnSync): compose the command name + every arg
            // into a single shell-quoted line. Each token (including the command
            // name) is single-quoted, so args are forwarded as literal argv
            // tokens — no glob, word-splitting, or metacharacter reparsing —
            // preserving spawnSync semantics. This works regardless of the
            // underlying exec engine, unlike the `options.args` injection path
            // which only the (now-removed) monolith engine honored — the
            // pipeline engine silently drops it (#49).
            if (parsed.args && Array.isArray(parsed.args)) {
              const argv = [
                command,
                ...parsed.args.map((a: unknown) => String(a)),
              ];
              command = shellJoinArgs(argv);
            }
          }

          const result = await this.raceDeadline(() =>
            execFn(command, options),
          );

          return new TextEncoder().encode(
            JSON.stringify({
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            }),
          );
        },
      );
    } catch (e) {
      this.resultCache = null;
      controller.abort();
      const message = e instanceof Error ? e.message : String(e);
      this.protocol.setErrorCode(
        this.sizeAwareErrorCode(e, ErrorCode.IO_ERROR),
      );
      this.protocol.setResultFromString(sanitizeErrorMessage(message));
      this.protocol.setStatus(Status.ERROR);
    }
  }

  /**
   * `PAYLOAD_TOO_LARGE` for a size-ceiling failure, otherwise `fallback`.
   * Typed on the error class rather than sniffed from the message text.
   */
  private sizeAwareErrorCode(
    e: unknown,
    fallback: ErrorCodeType,
  ): ErrorCodeType {
    return e instanceof PayloadTooLargeError
      ? ErrorCode.PAYLOAD_TOO_LARGE
      : fallback;
  }

  private setErrorFromException(e: unknown): void {
    const rawMessage = e instanceof Error ? e.message : String(e);
    const message = sanitizeErrorMessage(rawMessage);

    // A size-ceiling failure is typed, so it never has to be recovered from the
    // message text — and must not be flattened into a generic IO_ERROR.
    if (e instanceof PayloadTooLargeError) {
      this.protocol.setErrorCode(ErrorCode.PAYLOAD_TOO_LARGE);
      this.protocol.setResultFromString(message);
      this.protocol.setStatus(Status.ERROR);
      return;
    }

    let errorCode: ErrorCodeType = ErrorCode.IO_ERROR;
    const lowerMsg = rawMessage.toLowerCase();
    if (
      lowerMsg.includes("no such file") ||
      lowerMsg.includes("not found") ||
      lowerMsg.includes("enoent")
    ) {
      errorCode = ErrorCode.NOT_FOUND;
    } else if (
      lowerMsg.includes("is a directory") ||
      lowerMsg.includes("eisdir")
    ) {
      errorCode = ErrorCode.IS_DIRECTORY;
    } else if (
      lowerMsg.includes("not a directory") ||
      lowerMsg.includes("enotdir")
    ) {
      errorCode = ErrorCode.NOT_DIRECTORY;
    } else if (
      lowerMsg.includes("already exists") ||
      lowerMsg.includes("eexist")
    ) {
      errorCode = ErrorCode.EXISTS;
    } else if (
      lowerMsg.includes("permission") ||
      lowerMsg.includes("eperm") ||
      lowerMsg.includes("eacces")
    ) {
      errorCode = ErrorCode.PERMISSION_DENIED;
    }

    this.protocol.setErrorCode(errorCode);
    this.protocol.setResultFromString(message);
    this.protocol.setStatus(Status.ERROR);
  }
}
