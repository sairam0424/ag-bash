import { _clearTimeout, _setTimeout } from "../timers.js";
export class Command {
    cmdId;
    cwd;
    startedAt;
    exitCode;
    bashEnv;
    cmdLine;
    env;
    explicitCwd;
    signal;
    timeoutMs;
    abortController = new AbortController();
    timeoutId;
    externalAbortListener;
    resultPromise;
    constructor(bashEnv, cmdLine, cwd, env, explicitCwd = false, signal, timeoutMs) {
        this.cmdId = crypto.randomUUID();
        this.cwd = cwd;
        this.startedAt = new Date();
        this.bashEnv = bashEnv;
        this.cmdLine = cmdLine;
        this.env = env;
        this.explicitCwd = explicitCwd;
        this.signal = signal;
        this.timeoutMs = timeoutMs;
        this.setupCancellation();
        // Start execution immediately
        this.resultPromise = this.execute();
    }
    setupCancellation() {
        if (this.signal) {
            if (this.signal.aborted) {
                this.abortController.abort(this.signal.reason);
            }
            else {
                this.externalAbortListener = () => {
                    this.abortController.abort(this.signal?.reason);
                };
                this.signal.addEventListener("abort", this.externalAbortListener, {
                    once: true,
                });
            }
        }
        if (this.timeoutMs !== undefined) {
            const timeout = Math.max(0, this.timeoutMs);
            this.timeoutId = _setTimeout(() => {
                this.abortController.abort(new Error(`sandbox command timeout after ${timeout}ms`));
            }, timeout);
        }
    }
    cleanupCancellation() {
        if (this.timeoutId !== undefined) {
            _clearTimeout(this.timeoutId);
            this.timeoutId = undefined;
        }
        if (this.signal && this.externalAbortListener) {
            this.signal.removeEventListener("abort", this.externalAbortListener);
            this.externalAbortListener = undefined;
        }
    }
    async execute() {
        // Always pass command-specific signal to support cancellation.
        const options = {
            cwd: this.explicitCwd ? this.cwd : undefined,
            env: this.env,
            signal: this.abortController.signal,
        };
        try {
            const result = await this.bashEnv.exec(this.cmdLine, options);
            this.exitCode = result.exitCode;
            return result;
        }
        finally {
            this.cleanupCancellation();
        }
    }
    async *logs() {
        const result = await this.resultPromise;
        // For Bash, we don't have true streaming, so emit all at once
        if (result.stdout) {
            yield { type: "stdout", data: result.stdout, timestamp: new Date() };
        }
        if (result.stderr) {
            yield { type: "stderr", data: result.stderr, timestamp: new Date() };
        }
    }
    async wait() {
        await this.resultPromise;
        return this;
    }
    async output() {
        const result = await this.resultPromise;
        return result.stdout + result.stderr;
    }
    async stdout() {
        const result = await this.resultPromise;
        return result.stdout;
    }
    async stderr() {
        const result = await this.resultPromise;
        return result.stderr;
    }
    async kill() {
        this.abortController.abort(new Error("command killed"));
        // Preserve API contract: kill() resolves once cancellation has been requested.
    }
}
