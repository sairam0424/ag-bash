/**
 * python3 - Execute Python code via CPython Emscripten (Python in WebAssembly)
 *
 * Runs Python code in an isolated worker thread with access to the
 * virtual filesystem via SharedArrayBuffer bridge.
 *
 * Security: CPython Emscripten has zero JS bridge code. `import js` fails
 * with ModuleNotFoundError. No sandbox needed — isolation by construction.
 *
 * This command is Node.js only (uses worker_threads).
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { IFileSystem } from "../../fs/interface.js";
import {
  sanitizeErrorMessage,
  sanitizeHostErrorMessage,
} from "../../fs/sanitize-error.js";
import { mapToRecord } from "../../helpers/env.js";

import { bindDefenseContextCallback } from "../../security/defense-context.js";
import { DefenseInDepthBox } from "../../security/defense-in-depth-box.js";
import type { SessionManager } from "../../services/SessionManager.js";
import { _clearTimeout, _setTimeout } from "../../timers.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import { hasHelpFlag, showHelp } from "../help.js";
import { BridgeHandler } from "../worker-bridge/bridge-handler.js";
import { createSharedBuffer } from "../worker-bridge/protocol.js";
import type { WorkerInput, WorkerOutput } from "./worker.js";

/** Default Python execution timeout in milliseconds */
const DEFAULT_PYTHON_TIMEOUT_MS = 10000;
/** Default Python execution timeout when network is enabled */
const DEFAULT_PYTHON_NETWORK_TIMEOUT_MS = 60000;

const python3Help = {
  name: "python3",
  summary: "Execute Python code via CPython Emscripten",
  usage: "python3 [OPTIONS] [-c CODE | -m MODULE | FILE] [ARGS...]",
  description: [
    "Execute Python code using CPython compiled to WebAssembly via Emscripten.",
    "",
    "This command runs Python in an isolated environment with access to",
    "the virtual filesystem. Standard library modules are available.",
  ],
  options: [
    "-c CODE     Execute CODE as Python script",
    "-m MODULE   Run library module as a script",
    "--version   Show Python version",
    "--help      Show this help",
  ],
  examples: [
    'python3 -c "print(1 + 2)"',
    'python3 -c "import sys; print(sys.version)"',
    "python3 script.py",
    "python3 script.py arg1 arg2",
    "echo 'print(\"hello\")' | python3",
  ],
  notes: [
    "CPython runs in WebAssembly, so execution may be slower than native Python.",
    "Standard library modules are available (no pip install).",
    "Maximum execution time is 30 seconds by default.",
    "",
    "Capability matrix (CPython on WebAssembly via Emscripten):",
    "",
    "  Works — pure-Python / WASM-safe stdlib:",
    "    json, re, math, cmath, random, datetime, time, decimal, fractions,",
    "    hashlib, hmac, secrets, base64, binascii, struct, codecs,",
    "    collections, itertools, functools, operator, heapq, bisect, copy,",
    "    enum, dataclasses, typing, string, textwrap, unicodedata,",
    "    csv, io, statistics, uuid, pprint, difflib, array.",
    "",
    "  Works — bridged to the host through the worker bridge (no native syscalls):",
    "    Virtual filesystem I/O (open/read/write, os.path, pathlib, shutil,",
    "      tempfile against the sandboxed VFS).",
    "    sqlite3 — served via the host SQLite bridge, not a native libsqlite3.",
    "    Outbound HTTP via urllib/http.client ONLY when the shell was started",
    "      with network access enabled; routed through the host's vetted fetch",
    "      (SSRF-guarded). Disabled by default.",
    "",
    "  Structurally impossible — NOT available, and cannot be polyfilled here:",
    "    threading / _thread / concurrent.futures thread pools (no WASM threads).",
    "    multiprocessing / fork / subprocess (no process model in the worker).",
    "    socket / asyncio raw transports / selectors (no host socket API).",
    "    ssl (no socket layer to wrap).",
    "    ctypes / native extension modules / C-accelerated 3rd-party wheels.",
    "    signal handlers, os.fork, mmap-backed shared memory.",
    "  Importing these raises ModuleNotFoundError or fails at first use —",
    "  by design, not a bug. Use the bridged equivalents above instead.",
  ],
};

interface ParsedArgs {
  code: string | null;
  module: string | null;
  scriptFile: string | null;
  showVersion: boolean;
  scriptArgs: string[];
  sessionId: string | null;
}

function parseArgs(args: string[]): ParsedArgs | ExecResult {
  const result: ParsedArgs = {
    code: null,
    module: null,
    scriptFile: null,
    showVersion: false,
    scriptArgs: [],
    sessionId: null,
  };

  if (args.length === 0) {
    return result;
  }

  const firstArgIndex = args.findIndex((arg) => {
    return !arg.startsWith("-") || arg === "-" || arg === "--";
  });

  for (
    let i = 0;
    i < (firstArgIndex === -1 ? args.length : firstArgIndex);
    i++
  ) {
    const arg = args[i];

    if (arg === "-c") {
      if (i + 1 >= args.length) {
        return {
          stdout: "",
          stderr: "python3: option requires an argument -- 'c'\n",
          exitCode: 2,
        };
      }
      result.code = args[i + 1];
      result.scriptArgs = args.slice(i + 2);
      return result;
    }

    if (arg === "-m") {
      if (i + 1 >= args.length) {
        return {
          stdout: "",
          stderr: "python3: option requires an argument -- 'm'\n",
          exitCode: 2,
        };
      }
      result.module = args[i + 1];
      result.scriptArgs = args.slice(i + 2);
      return result;
    }

    if (arg === "--version" || arg === "-V") {
      result.showVersion = true;
      return result;
    }

    if (arg === "--session") {
      if (i + 1 >= args.length) {
        return {
          stdout: "",
          stderr: "python3: option requires an argument -- 'session'\n",
          exitCode: 2,
        };
      }
      result.sessionId = args[i + 1];
      i++;
      continue;
    }

    if (arg.startsWith("-") && arg !== "-") {
      return {
        stdout: "",
        stderr: `python3: unrecognized option '${arg}'\n`,
        exitCode: 2,
      };
    }
  }

  if (firstArgIndex !== -1) {
    const arg = args[firstArgIndex];
    if (arg === "--") {
      if (firstArgIndex + 1 < args.length) {
        result.scriptFile = args[firstArgIndex + 1];
        result.scriptArgs = args.slice(firstArgIndex + 2);
      }
    } else {
      result.scriptFile = arg;
      result.scriptArgs = args.slice(firstArgIndex + 1);
    }
  }

  return result;
}

// Queue for serializing Python executions (one at a time)
type QueuedExecution = {
  input: WorkerInput;
  resolve: (result: WorkerOutput) => void;
  workerRef?: { current: Worker | null; terminateOnAttach?: boolean };
  requireDefenseContext?: boolean;
  /** Set to true when the request times out before execution starts */
  canceled?: boolean;
  /** Set to true when the request has been resolved or rejected */
  resolved?: boolean;
  /** SessionManager instance from the owning Bash context */
  sessionManager?: SessionManager;
};
type QueueState = {
  executionQueue: QueuedExecution[];
  isExecuting: boolean;
};
let executionQueues = new WeakMap<IFileSystem, QueueState>();

function getQueueState(fs: IFileSystem): QueueState {
  let state = executionQueues.get(fs);
  if (!state) {
    state = {
      executionQueue: [],
      isExecuting: false,
    };
    executionQueues.set(fs, state);
  }
  return state;
}

/** @internal Reset queue state — for tests only */
export function _resetExecutionQueue(): void {
  executionQueues = new WeakMap();
}

// Resolve worker path with fallbacks for Node.js, Vitest, and Browser contexts
let _workerPathCache: string | URL | null = null;

function findWorkerPath(): string {
  let _workerPath = "worker.js";
  const isNode = typeof process !== "undefined";

  const hasImportMeta = typeof import.meta !== "undefined";
  if (hasImportMeta && import.meta.url) {
    try {
      const url = new URL(import.meta.url);
      if (url.protocol === "file:") {
        const baseDir = dirname(fileURLToPath(url));
        const localPath = join(baseDir, "worker.js");

        if (isNode) {
          const paths = [
            localPath,
            join(baseDir, "python-worker.js"),
            join(baseDir, "chunks", "python-worker.js"),
            join(baseDir, "..", "commands", "python3", "worker.js"),
            join(baseDir, "../../../dist/commands/python3/worker.js"),
          ];

          for (const p of paths) {
            if (existsSync(p)) {
              return p;
            }
          }
        }
        _workerPath = localPath;
      }
    } catch {
      // ignore
    }
  }
  return _workerPath;
}

async function getWorkerPath() {
  if (_workerPathCache) return _workerPathCache;
  const path = findWorkerPath();
  _workerPathCache = path;
  return path;
}

function generateWorkerProtocolToken(): string {
  return randomBytes(16).toString("hex");
}

function normalizeWorkerMessage(
  msg: unknown,
  expectedProtocolToken: string,
): WorkerOutput {
  if (!msg || typeof msg !== "object") {
    return {
      success: false,
      error: "Malformed worker response",
    };
  }

  const raw = msg as {
    protocolToken?: unknown;
    type?: unknown;
    violation?: { type?: unknown };
    success?: unknown;
    error?: unknown;
  };

  if (
    typeof raw.protocolToken !== "string" ||
    raw.protocolToken !== expectedProtocolToken
  ) {
    return {
      success: false,
      error: "Malformed worker response: invalid protocol token",
    };
  }

  if (raw.type === "security-violation") {
    return {
      success: false,
      error: `Security violation: ${
        typeof raw.violation?.type === "string" ? raw.violation.type : "unknown"
      }`,
    };
  }

  if (typeof raw.success !== "boolean") {
    return {
      success: false,
      error: "Malformed worker response: missing success flag",
    };
  }

  if (raw.success) {
    return { success: true };
  }

  return {
    success: false,
    error:
      typeof raw.error === "string" && raw.error.length > 0
        ? raw.error
        : "Worker execution failed",
  };
}

async function processNextExecution(queueState: QueueState): Promise<void> {
  if (queueState.isExecuting) {
    return;
  }

  // Skip canceled entries (timed out before execution started)
  while (queueState.executionQueue.length > 0) {
    if (queueState.executionQueue[0].canceled) {
      queueState.executionQueue.shift();
      continue;
    }
    break;
  }

  if (queueState.executionQueue.length === 0) {
    return;
  }

  const next = queueState.executionQueue.shift();
  if (!next) {
    return;
  }
  queueState.isExecuting = true;

  const sessionManager = next.sessionManager;
  let w: Worker | null = null;
  const sessionId = next.input.sessionId;

  if (sessionId && sessionManager) {
    const session = sessionManager.getSession(sessionId);
    if (session && session.type === "python") {
      w = session.worker;
    }
  }

  if (!w) {
    const workerPath = await getWorkerPath();
    w = await DefenseInDepthBox.runTrustedAsync(async () => {
      const { Worker: NodeWorker } = await import("node:worker_threads");
      return new NodeWorker(workerPath as string, {
        workerData: next.input,
      });
    });

    if (sessionId && sessionManager) {
      sessionManager.createSession("python", w, sessionId);
    }
  }

  const _worker = w;
  // Fresh worker for each execution (unless persistent)
  const attachListeners = (w: Worker) => {
    if (next.workerRef) {
      // F1 hardening: if the owning executePython already decided to tear down
      // (bridge error / deadline) before this worker finished spawning, the
      // worker would otherwise leak. Honor a pending teardown request the
      // instant the worker becomes available.
      if (next.workerRef.terminateOnAttach && !next.input.persistent) {
        void w.terminate();
        next.workerRef.current = null;
        if (!next.resolved) {
          next.resolved = true;
          next.resolve({
            success: false,
            error: "Worker terminated before execution completed",
          });
          queueState.isExecuting = false;
          void processNextExecution(queueState);
        }
        return;
      }
      next.workerRef.current = w;
    }

    const onMessage = bindDefenseContextCallback(
      next.requireDefenseContext,
      "python3",
      "worker message callback",
      async (msg: unknown) => {
        if (next.resolved) return;
        next.resolved = true;
        next.resolve(normalizeWorkerMessage(msg, next.input.protocolToken));
        queueState.isExecuting = false;
        if (!next.input.persistent) {
          await w.terminate();
        }
        void processNextExecution(queueState);
      },
    );
    const onError = bindDefenseContextCallback(
      next.requireDefenseContext,
      "python3",
      "worker error callback",
      async (err: Error) => {
        if (next.resolved) return;
        next.resolved = true;
        const workerError = sanitizeHostErrorMessage(err.message);
        next.resolve({
          success: false,
          error: workerError,
        });
        queueState.isExecuting = false;
        await w.terminate();
        void processNextExecution(queueState);
      },
    );
    const onExit = bindDefenseContextCallback(
      next.requireDefenseContext,
      "python3",
      "worker exit callback",
      async (code: number) => {
        setImmediate(async () => {
          if (queueState.isExecuting && !next.resolved) {
            next.resolved = true;
            next.resolve({
              success: false,
              error: `Worker exited unexpectedly with code ${code}`,
            });
            queueState.isExecuting = false;
            void processNextExecution(queueState);
          }
        });
      },
    );

    const currentExecution = next;
    const onErrorSync = (err: unknown) => {
      if (currentExecution.resolved) return;
      currentExecution.resolved = true;
      const message = err instanceof Error ? err.message : String(err);
      currentExecution.resolve({
        success: false,
        error: sanitizeHostErrorMessage(message),
      });
      queueState.isExecuting = false;
      void w.terminate();
      void processNextExecution(queueState);
    };

    w.on("message", (msg) => {
      try {
        void onMessage(msg);
      } catch (err) {
        onErrorSync(err);
      }
    });
    w.on("error", (err) => {
      try {
        if (err instanceof Error) {
          void onError(err);
        } else {
          void onError(new Error(String(err)));
        }
      } catch (e) {
        onErrorSync(e);
      }
    });
    w.on("exit", (code) => {
      try {
        void onExit(code);
      } catch (err) {
        onErrorSync(err);
      }
    });
  };

  try {
    await DefenseInDepthBox.runTrustedAsync(async () => {
      if (
        typeof process !== "undefined" &&
        process.versions &&
        process.versions.node
      ) {
        const path = await getWorkerPath();
        const { Worker: NodeWorker } = await import("node:worker_threads");
        const w = new NodeWorker(path as string, {
          workerData: next.input,
        });
        attachListeners(w);
        return w;
      }
      const path = await getWorkerPath();
      const w = new (
        Worker as unknown as {
          new (url: string | URL, options?: { type: "module" }): Worker;
        }
      )(path as string | URL, {
        type: "module",
      });
      attachListeners(w);
      return w;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    next.resolve({
      success: false,
      error: sanitizeHostErrorMessage(message),
    });
    queueState.isExecuting = false;
    void processNextExecution(queueState);
  }
}

/**
 * Execute Python code in a worker with filesystem bridge.
 */
async function executePython(
  pythonCode: string,
  ctx: CommandContext,
  scriptPath?: string,
  scriptArgs: string[] = [],
  sessionId?: string | null,
): Promise<ExecResult> {
  const sharedBuffer = createSharedBuffer();
  const bridgeHandler = new BridgeHandler(
    sharedBuffer,
    ctx.fs,
    ctx.cwd,
    "python3",
    ctx.fetch,
    ctx.limits?.maxOutputSize ?? 0,
  );

  const userTimeout =
    ctx.limits?.maxPythonTimeoutMs ?? DEFAULT_PYTHON_TIMEOUT_MS;
  const timeoutMs = ctx.fetch
    ? Math.max(userTimeout, DEFAULT_PYTHON_NETWORK_TIMEOUT_MS)
    : userTimeout;
  const queueState = getQueueState(ctx.fs);

  const workerInput: WorkerInput = {
    protocolToken: generateWorkerProtocolToken(),
    sharedBuffer,
    pythonCode,
    cwd: ctx.cwd,
    env: mapToRecord(ctx.env),
    args: scriptArgs,
    scriptPath,
    timeoutMs,
    persistent: !!sessionId || !!ctx.sessionId,
    sessionId: sessionId || ctx.sessionId,
  };

  const workerRef: { current: Worker | null; terminateOnAttach?: boolean } = {
    current: null,
  };

  const workerPromise = new Promise<WorkerOutput>((resolve) => {
    const queueEntry: QueuedExecution = {
      input: workerInput,
      resolve: () => {},
      workerRef,
      requireDefenseContext: ctx.requireDefenseContext,
      sessionManager: ctx.bash?.services?.sessionManager,
    };

    const onTimeout = bindDefenseContextCallback(
      ctx.requireDefenseContext,
      "python3",
      "worker timeout callback",
      () => {
        if (workerRef.current) {
          workerRef.current.terminate();
        } else {
          queueEntry.canceled = true;
        }
        resolve({
          success: false,
          error: `Execution timeout: exceeded ${timeoutMs}ms limit`,
        });
      },
    );

    const dispatchTimeout = (): void => {
      try {
        onTimeout();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolve({
          success: false,
          error: sanitizeHostErrorMessage(message),
        });
      }
    };

    const timeout = _setTimeout(dispatchTimeout, timeoutMs);

    queueEntry.resolve = (result: WorkerOutput) => {
      _clearTimeout(timeout);
      resolve(result);
    };

    queueState.executionQueue.push(queueEntry);
    processNextExecution(queueState);
  });

  let bridgeOutput: ExecResult;
  let workerResult: { success: boolean; error?: string };

  try {
    type RaceResult =
      | {
          type: "both";
          bridge: ExecResult;
          worker: { success: boolean; error?: string };
        }
      | { type: "worker_fail"; error: unknown };

    const result = (await Promise.race([
      Promise.all([bridgeHandler.run(timeoutMs), workerPromise]).then(
        ([bridge, worker]) => ({ type: "both" as const, bridge, worker }),
      ),

      workerPromise
        .then((w) => {
          if (!w.success) {
            return { type: "worker_fail" as const, error: w.error };
          }
          return new Promise<RaceResult>(() => {});
        })
        .catch((err) => ({ type: "worker_fail" as const, error: err })),
    ])) as RaceResult;

    if (result.type === "both") {
      bridgeOutput = result.bridge;
      workerResult = result.worker;
    } else {
      bridgeOutput = bridgeHandler.getOutput();
      if (bridgeOutput.exitCode === 0) bridgeOutput.exitCode = 1;
      workerResult = {
        success: false,
        error: sanitizeHostErrorMessage(
          result.error instanceof Error
            ? result.error.message
            : String(result.error),
        ),
      };
    }
  } catch (e) {
    bridgeOutput = { stdout: "", stderr: "", exitCode: 1 };
    const errMsg = e instanceof Error ? e.message : String(e);
    workerResult = {
      success: false,
      error: sanitizeHostErrorMessage(`bridge error: ${errMsg}`),
    };
  } finally {
    // F1 hardening: guarantee a non-persistent worker is terminated no matter
    // which race branch settled first. A worker blocked mid-Atomics.wait when
    // the bridge loop or a deadline expires would otherwise leak — the
    // per-callback terminate() calls cover the happy paths, but the
    // `worker_fail` / `bridge error` branches above can return while the worker
    // thread is still alive. terminate() is idempotent, so a redundant call on
    // an already-terminated worker is harmless. Persistent (session) workers
    // are intentionally left running for reuse.
    if (!workerInput.persistent) {
      if (workerRef.current) {
        void workerRef.current.terminate();
        workerRef.current = null;
      } else {
        // The worker may still be spawning (e.g. the bridge threw before
        // attachListeners ran). Request teardown so it is terminated the
        // instant it becomes available — closing the late-spawn leak window.
        workerRef.terminateOnAttach = true;
      }
    }
  }

  if (!workerResult.success && workerResult.error) {
    const workerError = sanitizeHostErrorMessage(workerResult.error);
    return {
      stdout: bridgeOutput.stdout,
      stderr: `${bridgeOutput.stderr}python3: ${workerError}\n`,
      exitCode: bridgeOutput.exitCode || 1,
    };
  }

  return bridgeOutput;
}

export const python3Command: Command = {
  name: "python3",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(python3Help);
    }

    const parsed = parseArgs(args);
    if ("exitCode" in parsed) return parsed;

    if (parsed.showVersion) {
      return {
        stdout: "Python 3.13.2 (Emscripten)\n",
        stderr: "",
        exitCode: 0,
      };
    }

    let pythonCode: string;
    let scriptPath: string | undefined;

    if (parsed.code !== null) {
      pythonCode = parsed.code;
      scriptPath = "-c";
    } else if (parsed.module !== null) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(parsed.module)) {
        return {
          stdout: "",
          stderr: `python3: No module named '${parsed.module.slice(0, 200)}'\n`,
          exitCode: 1,
        };
      }
      pythonCode = `import runpy; runpy.run_module('${parsed.module}', run_name='__main__')`;
      scriptPath = parsed.module;
    } else if (parsed.scriptFile !== null) {
      const filePath = ctx.fs.resolvePath(ctx.cwd, parsed.scriptFile);

      if (!(await ctx.fs.exists(filePath))) {
        return {
          stdout: "",
          stderr: `python3: can't open file '${parsed.scriptFile}': [Errno 2] No such file or directory\n`,
          exitCode: 2,
        };
      }

      try {
        pythonCode = await ctx.fs.readFile(filePath);
        scriptPath = parsed.scriptFile;
      } catch (e) {
        const message = sanitizeErrorMessage((e as Error).message);
        return {
          stdout: "",
          stderr: `python3: can't open file '${parsed.scriptFile}': ${message}\n`,
          exitCode: 2,
        };
      }
    } else if (ctx.stdin.trim()) {
      pythonCode = ctx.stdin;
      scriptPath = "<stdin>";
    } else {
      return {
        stdout: "",
        stderr:
          "python3: no input provided (use -c CODE, -m MODULE, or provide a script file)\n",
        exitCode: 2,
      };
    }

    return executePython(
      pythonCode,
      ctx,
      scriptPath,
      parsed.scriptArgs,
      parsed.sessionId,
    );
  },
};

export const pythonCommand: Command = {
  name: "python",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    return python3Command.execute(args, ctx);
  },
};
