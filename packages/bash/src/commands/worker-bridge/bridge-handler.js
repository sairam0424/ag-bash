/**
 * Main thread bridge handler
 *
 * Runs on the main thread and processes filesystem, I/O, HTTP, and exec
 * requests from a worker thread via SharedArrayBuffer + Atomics.
 */
import { sanitizeErrorMessage } from "../../fs/real-fs-utils.js";
import { shellJoinArgs } from "../../helpers/shell-quote.js";
import { _clearTimeout, _setTimeout } from "../../timers.js";
import {
  ErrorCode,
  Flags,
  OpCode,
  ProtocolBuffer,
  Status,
} from "./protocol.js";
/**
 * Handles requests from a worker thread.
 */
export class BridgeHandler {
  fs;
  cwd;
  commandName;
  secureFetch;
  maxOutputSize;
  exec;
  protocol;
  running = false;
  output = { stdout: "", stderr: "", exitCode: 0 };
  outputLimitExceeded = false;
  startTime = 0;
  timeoutMs = 0;
  constructor(
    sharedBuffer,
    fs,
    cwd,
    commandName,
    secureFetch = undefined,
    maxOutputSize = 0,
    exec = undefined,
  ) {
    this.fs = fs;
    this.cwd = cwd;
    this.commandName = commandName;
    this.secureFetch = secureFetch;
    this.maxOutputSize = maxOutputSize;
    this.exec = exec;
    this.protocol = new ProtocolBuffer(sharedBuffer);
  }
  /**
   * Returns remaining milliseconds before the overall execution deadline.
   */
  remainingMs() {
    return Math.max(0, this.timeoutMs - (Date.now() - this.startTime));
  }
  /**
   * Races a promise against the remaining execution deadline.
   * If the deadline expires first, sets `this.running = false` and rejects.
   */
  raceDeadline(fn) {
    const remaining = this.remainingMs();
    if (remaining <= 0) {
      this.running = false;
      this.output.exitCode = 124;
      this.output.stderr += `\n${this.commandName}: execution timeout exceeded\n`;
      return Promise.reject(new Error("Operation timed out"));
    }
    const promise = fn();
    return new Promise((resolve, reject) => {
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
  async run(timeoutMs) {
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
  stop() {
    this.running = false;
  }
  async handleOperation(opCode) {
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
  resolvePath(path) {
    return this.fs.resolvePath(this.cwd, path);
  }
  async handleReadFile() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const content = await this.fs.readFileBuffer(path);
      this.protocol.setResult(content);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleWriteFile() {
    const path = this.resolvePath(this.protocol.getPath());
    const data = this.protocol.getData();
    try {
      await this.fs.writeFile(path, data);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleStat() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const stat = await this.fs.stat(path);
      this.protocol.encodeStat(stat);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleLstat() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const stat = await this.fs.lstat(path);
      this.protocol.encodeStat(stat);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleReaddir() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const entries = await this.fs.readdir(path);
      this.protocol.setResultFromString(JSON.stringify(entries));
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleMkdir() {
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
  async handleRm() {
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
  async handleExists() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const exists = await this.fs.exists(path);
      this.protocol.setResult(new Uint8Array([exists ? 1 : 0]));
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleAppendFile() {
    const path = this.resolvePath(this.protocol.getPath());
    const data = this.protocol.getData();
    try {
      await this.fs.appendFile(path, data);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleSymlink() {
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
  async handleReadlink() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const target = await this.fs.readlink(path);
      this.protocol.setResultFromString(target);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleChmod() {
    const path = this.resolvePath(this.protocol.getPath());
    const mode = this.protocol.getMode();
    try {
      await this.fs.chmod(path, mode);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleRealpath() {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const realpath = await this.fs.realpath(path);
      this.protocol.setResultFromString(realpath);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleRename() {
    const oldPath = this.resolvePath(this.protocol.getPath());
    const newPath = this.resolvePath(this.protocol.getDataAsString());
    try {
      await this.fs.mv(oldPath, newPath);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  async handleCopyFile() {
    const src = this.resolvePath(this.protocol.getPath());
    const dest = this.resolvePath(this.protocol.getDataAsString());
    try {
      await this.fs.cp(src, dest);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }
  handleWriteStdout() {
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
  handleWriteStderr() {
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
  handleExit() {
    const exitCode = this.protocol.getFlags();
    if (!this.outputLimitExceeded) {
      this.output.exitCode = exitCode;
    } else if (this.output.exitCode === 0) {
      this.output.exitCode = 1;
    }
    this.protocol.setStatus(Status.SUCCESS);
    this.running = false;
  }
  tryAppendOutput(stream, data) {
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
  appendOutputLimitError() {
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
  async handleHttpRequest() {
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
    const requestJson = this.protocol.getDataAsString();
    try {
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
      const response = JSON.stringify({
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        body: result.body,
        url: result.url,
      });
      this.protocol.setResultFromString(response);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      const message = sanitizeErrorMessage(
        e instanceof Error ? e.message : String(e),
      );
      this.protocol.setErrorCode(ErrorCode.NETWORK_ERROR);
      this.protocol.setResultFromString(message);
      this.protocol.setStatus(Status.ERROR);
    }
  }
  async handleExecCommand() {
    const execFn = this.exec;
    if (!execFn) {
      this.protocol.setErrorCode(ErrorCode.IO_ERROR);
      this.protocol.setResultFromString(
        "Command execution not available in this context.",
      );
      this.protocol.setStatus(Status.ERROR);
      return;
    }
    let command = this.protocol.getPath();
    const dataStr = this.protocol.getDataAsString();
    // Cap exec to the remaining execution deadline via AbortSignal + raceDeadline.
    // AbortSignal provides cooperative cancellation; raceDeadline guarantees
    // we don't hang if exec never respects the signal.
    const controller = new AbortController();
    try {
      const options = {
        cwd: this.cwd,
        signal: controller.signal,
      };
      if (dataStr) {
        const parsed = JSON.parse(dataStr);
        if (parsed.stdin) {
          options.stdin = parsed.stdin;
        }
        // Structured args: pass directly via args option (no shell escaping needed)
        if (parsed.args && Array.isArray(parsed.args)) {
          options.args = parsed.args.map((a) => String(a));
          command = shellJoinArgs([command]);
        }
      }
      const result = await this.raceDeadline(() => execFn(command, options));
      const response = JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
      this.protocol.setResultFromString(response);
      this.protocol.setStatus(Status.SUCCESS);
    } catch (e) {
      controller.abort();
      const message = e instanceof Error ? e.message : String(e);
      this.protocol.setErrorCode(ErrorCode.IO_ERROR);
      this.protocol.setResultFromString(message);
      this.protocol.setStatus(Status.ERROR);
    }
  }
  setErrorFromException(e) {
    const rawMessage = e instanceof Error ? e.message : String(e);
    const message = sanitizeErrorMessage(rawMessage);
    let errorCode = ErrorCode.IO_ERROR;
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
