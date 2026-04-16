import { Bash } from "../Bash.js";
import { OverlayFs } from "../fs/overlay-fs/index.js";
import { shellJoinArgs } from "../helpers/shell-quote.js";
import { Command } from "./Command.js";
export class Sandbox {
    bashEnv;
    timeoutMs;
    constructor(bashEnv, timeoutMs) {
        this.bashEnv = bashEnv;
        this.timeoutMs = timeoutMs;
    }
    static async create(opts) {
        // Determine filesystem: overlayRoot creates an OverlayFs, otherwise use provided fs
        let fs = opts?.fs;
        if (opts?.overlayRoot) {
            if (opts?.fs) {
                throw new Error("Cannot specify both 'fs' and 'overlayRoot' options");
            }
            fs = new OverlayFs({ root: opts.overlayRoot });
        }
        const bashEnv = new Bash({
            env: opts?.env,
            cwd: opts?.cwd,
            // Bash-specific extensions
            fs,
            maxCallDepth: opts?.maxCallDepth,
            maxCommandCount: opts?.maxCommandCount,
            maxLoopIterations: opts?.maxLoopIterations,
            network: opts?.network,
            defenseInDepth: opts?.defenseInDepth,
        });
        return new Sandbox(bashEnv, opts?.timeoutMs);
    }
    async runCommand(cmdOrParams, argsOrOpts, _opts) {
        let cmdLine;
        let cwd;
        // @banned-pattern-ignore: static keys only, never accessed with user input
        let env;
        let signal;
        let detached = false;
        let stdoutStream;
        let stderrStream;
        if (typeof cmdOrParams === "object") {
            // Object form: runCommand({ cmd, args?, cwd?, env?, detached?, ... })
            const p = cmdOrParams;
            const argv = [p.cmd, ...(p.args ?? [])];
            cmdLine = shellJoinArgs(argv);
            cwd = p.cwd;
            env = p.env;
            signal = p.signal;
            detached = p.detached ?? false;
            stdoutStream = p.stdout;
            stderrStream = p.stderr;
        }
        else if (Array.isArray(argsOrOpts)) {
            // String + args form: runCommand('node', ['--version'])
            const runOpts = _opts;
            cmdLine = shellJoinArgs([cmdOrParams, ...argsOrOpts]);
            signal = runOpts?.signal;
        }
        else {
            // String form or legacy string + opts
            cmdLine = cmdOrParams;
            const legacyOpts = argsOrOpts;
            cwd = legacyOpts?.cwd;
            env = legacyOpts?.env;
        }
        const resolvedCwd = cwd ?? this.bashEnv.getCwd();
        const explicitCwd = cwd !== undefined;
        const command = new Command(this.bashEnv, cmdLine, resolvedCwd, env, explicitCwd, signal, this.timeoutMs);
        if (detached) {
            return command;
        }
        // Wait for completion, pipe to streams if provided
        const finished = await command.wait();
        if (stdoutStream) {
            const stdout = await command.stdout();
            if (stdout)
                stdoutStream.write(stdout);
        }
        if (stderrStream) {
            const stderr = await command.stderr();
            if (stderr)
                stderrStream.write(stderr);
        }
        return finished;
    }
    async writeFiles(files) {
        const cwd = this.bashEnv.getCwd();
        for (const [path, content] of Object.entries(files)) {
            let data;
            if (typeof content === "string") {
                data = content;
            }
            else {
                if (content.encoding === "base64") {
                    data = Buffer.from(content.content, "base64").toString("utf-8");
                }
                else {
                    data = content.content;
                }
            }
            // Ensure parent directory exists
            const resolvedPath = this.bashEnv.fs.resolvePath(cwd, path);
            const parentDir = resolvedPath.substring(0, resolvedPath.lastIndexOf("/")) || "/";
            if (parentDir !== "/") {
                await this.bashEnv.fs.mkdir(parentDir, { recursive: true });
            }
            await this.bashEnv.writeFile(resolvedPath, data);
        }
    }
    async readFile(path, encoding) {
        const content = await this.bashEnv.readFile(path);
        if (encoding === "base64") {
            return Buffer.from(content).toString("base64");
        }
        return content;
    }
    async mkDir(path, opts) {
        const resolvedPath = this.bashEnv.fs.resolvePath(this.bashEnv.getCwd(), path);
        await this.bashEnv.fs.mkdir(resolvedPath, {
            recursive: opts?.recursive ?? false,
        });
    }
    async stop() {
        // No-op for local simulation
    }
    async extendTimeout(_ms) {
        // No-op for local simulation
    }
    get domain() {
        return undefined; // Not applicable for local simulation
    }
    /**
     * Bash-specific: Get the underlying Bash instance for advanced operations.
     * Not available in standard Sandbox API.
     */
    get bashEnvInstance() {
        return this.bashEnv;
    }
}
export { Command };
