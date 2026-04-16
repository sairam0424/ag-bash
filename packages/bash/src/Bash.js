/**
 * Bash - Bash Shell Environment
 *
 * A complete bash-like shell environment using a proper AST-based architecture:
 *   Input → Parser → AST → Interpreter → Output
 *
 * This class provides the shell environment (filesystem, commands, variables)
 * and delegates execution to the Interpreter.
 */
// Eagerly import timers to capture references before defense-in-depth patches them
import "./timers.js";
import {
  createJavaScriptCommands,
  createLazyCommands,
  createNetworkCommands,
  createPythonCommands,
} from "./commands/registry.js";
import { createLazyCustomCommand, isLazyCommand } from "./custom-commands.js";
import { InMemoryFs } from "./fs/in-memory-fs/in-memory-fs.js";
import { initFilesystem } from "./fs/init.js";
import { sanitizeErrorMessage } from "./fs/sanitize-error.js";
import {
  mapToRecord,
  mapToRecordWithExtras,
  mergeToNullPrototype,
} from "./helpers/env.js";
import {
  ArithmeticError,
  ExecutionAbortedError,
  ExecutionLimitError,
  ExitError,
  PosixFatalError,
} from "./interpreter/errors.js";
import {
  buildBashopts,
  buildShellopts,
} from "./interpreter/helpers/shellopts.js";
import { Interpreter } from "./interpreter/index.js";
import { resolveLimits } from "./limits.js";
import { createSecureFetch } from "./network/index.js";
import { LexerError } from "./parser/lexer.js";
import { parse } from "./parser/parser.js";
import {
  DefenseInDepthBox,
  SecurityViolationError,
} from "./security/defense-in-depth-box.js";
import { serialize } from "./transform/serialize.js";
export class Bash {
  fs;
  commands = new Map();
  useDefaultLayout = false;
  limits;
  secureFetch;
  sleepFn;
  traceFn;
  logger;
  defenseInDepthConfig;
  coverageWriter;
  jsBootstrapCode;
  // biome-ignore lint/suspicious/noExplicitAny: type-erased plugin storage for untyped API
  transformPlugins = [];
  // Interpreter state (shared with interpreter instances)
  state;
  constructor(options = {}) {
    const fs = options.fs ?? new InMemoryFs(options.files);
    this.fs = fs;
    this.useDefaultLayout = !options.cwd && !options.files;
    const cwd = options.cwd || (this.useDefaultLayout ? "/home/user" : "/");
    // Use Map for env to prevent prototype pollution attacks
    const env = new Map([
      ["HOME", this.useDefaultLayout ? "/home/user" : "/"],
      ["PATH", "/usr/bin:/bin"],
      ["IFS", " \t\n"],
      ["OSTYPE", "linux-gnu"],
      ["MACHTYPE", "x86_64-pc-linux-gnu"],
      ["HOSTTYPE", "x86_64"],
      ["HOSTNAME", "localhost"], // Match hostname command in sandboxed environment
      ["PWD", cwd],
      ["OLDPWD", cwd],
      ["OPTIND", "1"], // getopts option index
      // Add user-provided env vars
      ...Object.entries(options.env ?? {}),
    ]);
    // Resolve limits: new executionLimits takes precedence, then deprecated individual options
    this.limits = resolveLimits({
      ...options.executionLimits,
      // Support deprecated individual options (they override executionLimits if set)
      ...(options.maxCallDepth !== undefined && {
        maxCallDepth: options.maxCallDepth,
      }),
      ...(options.maxCommandCount !== undefined && {
        maxCommandCount: options.maxCommandCount,
      }),
      ...(options.maxLoopIterations !== undefined && {
        maxLoopIterations: options.maxLoopIterations,
      }),
    });
    // Create secure fetch: prefer explicit fetch, fall back to network config
    if (options.fetch) {
      this.secureFetch = options.fetch;
    } else if (options.network) {
      this.secureFetch = createSecureFetch(options.network);
    }
    // Store sleep function if provided (for mock clocks in testing)
    this.sleepFn = options.sleep;
    // Store trace callback if provided (for performance profiling)
    this.traceFn = options.trace;
    // Store logger if provided
    this.logger = options.logger;
    // Defense-in-depth defaults to enabled
    this.defenseInDepthConfig = options.defenseInDepth ?? true;
    // Store coverage writer if provided (for fuzzing instrumentation)
    this.coverageWriter = options.coverage;
    // Initialize interpreter state
    this.state = {
      env,
      cwd,
      previousDir: "/home/user",
      functions: new Map(),
      localScopes: [],
      callDepth: 0,
      sourceDepth: 0,
      commandCount: 0,
      lastExitCode: 0,
      lastArg: "", // $_ is initially empty (or could be shell name)
      startTime: Date.now(),
      lastBackgroundPid: 0,
      virtualPid: options.processInfo?.pid ?? 1,
      virtualPpid: options.processInfo?.ppid ?? 0,
      virtualUid: options.processInfo?.uid ?? 1000,
      virtualGid: options.processInfo?.gid ?? 1000,
      bashPid: options.processInfo?.pid ?? 1, // BASHPID starts as virtual PID
      nextVirtualPid: (options.processInfo?.pid ?? 1) + 1, // Counter for unique subshell PIDs
      currentLine: 1, // $LINENO starts at 1
      options: {
        errexit: false,
        pipefail: false,
        nounset: false,
        xtrace: false,
        verbose: false,
        posix: false,
        allexport: false,
        noclobber: false,
        noglob: false,
        noexec: false,
        vi: false,
        emacs: false,
      },
      shoptOptions: {
        extglob: false,
        dotglob: false,
        nullglob: false,
        failglob: false,
        globstar: false,
        globskipdots: true, // Default to true in bash >=5.2
        nocaseglob: false,
        nocasematch: false,
        expand_aliases: false,
        lastpipe: false,
        xpg_echo: false,
      },
      inCondition: false,
      loopDepth: 0,
      // Export standard shell variables by default (matches bash behavior)
      // These variables are typically inherited from the parent shell environment
      exportedVars: new Set([
        "HOME",
        "PATH",
        "PWD",
        "OLDPWD",
        // Also export any user-provided environment variables
        ...Object.keys(options.env || {}),
      ]),
      // SHELLOPTS and BASHOPTS are readonly
      readonlyVars: new Set(["SHELLOPTS", "BASHOPTS"]),
      // Hash table for PATH command lookup caching
      hashTable: new Map(),
    };
    // Initialize SHELLOPTS to reflect current shell options (initially empty string since all are false)
    this.state.env.set("SHELLOPTS", buildShellopts(this.state.options));
    // Initialize BASHOPTS to reflect current shopt options
    this.state.env.set("BASHOPTS", buildBashopts(this.state.shoptOptions));
    // Initialize filesystem with standard directories and device files
    // Only applies to InMemoryFs - other filesystems use real directories
    initFilesystem(fs, this.useDefaultLayout, {
      pid: this.state.virtualPid,
      ppid: this.state.virtualPpid,
      uid: this.state.virtualUid,
      gid: this.state.virtualGid,
    });
    if (cwd !== "/" && fs instanceof InMemoryFs) {
      try {
        fs.mkdirSync(cwd, { recursive: true });
      } catch {
        // Ignore errors
      }
    }
    for (const cmd of createLazyCommands(options.commands)) {
      this.registerCommand(cmd);
    }
    // Register network commands when fetch or network is configured
    if (options.fetch || options.network) {
      for (const cmd of createNetworkCommands()) {
        this.registerCommand(cmd);
      }
    }
    // Register python commands only when explicitly enabled
    // Python introduces additional security surface (arbitrary code execution)
    if (options.python) {
      for (const cmd of createPythonCommands()) {
        this.registerCommand(cmd);
      }
    }
    // Register javascript commands only when explicitly enabled
    if (options.javascript) {
      for (const cmd of createJavaScriptCommands()) {
        this.registerCommand(cmd);
      }
      // Store bootstrap code in private field (threaded via context chain, not env)
      const jsConfig =
        typeof options.javascript === "object"
          ? options.javascript
          : Object.create(null);
      if (jsConfig.bootstrap) {
        this.jsBootstrapCode = jsConfig.bootstrap;
      }
    }
    // Register custom commands (after built-ins so they can override)
    if (options.customCommands) {
      for (const cmd of options.customCommands) {
        if (isLazyCommand(cmd)) {
          this.registerCommand(createLazyCustomCommand(cmd));
        } else {
          this.registerCommand({
            ...cmd,
            trusted: cmd.trusted ?? true,
          });
        }
      }
    }
  }
  registerCommand(command) {
    this.commands.set(command.name, command);
    // Create command stubs in /bin and /usr/bin for PATH-based resolution
    // Works for both InMemoryFs and OverlayFs (both have writeFileSync)
    // Commands are registered to both locations like real Linux systems
    // (where /bin is often a symlink to /usr/bin on modern systems)
    const fs = this.fs;
    if (typeof fs.writeFileSync === "function") {
      const stub = `#!/bin/bash\n# Built-in command: ${command.name}\n`;
      try {
        fs.writeFileSync(`/bin/${command.name}`, stub);
      } catch {
        // Ignore errors
      }
      try {
        fs.writeFileSync(`/usr/bin/${command.name}`, stub);
      } catch {
        // Ignore errors
      }
    }
  }
  logResult(result) {
    if (this.logger) {
      if (result.stdout) {
        this.logger.debug("stdout", { output: result.stdout });
      }
      if (result.stderr) {
        this.logger.info("stderr", { output: result.stderr });
      }
      this.logger.info("exit", { exitCode: result.exitCode });
    }
    // Decode binary strings (latin1) to UTF-8 at the output boundary.
    // Internally, the pipeline uses binary strings where each char = one byte
    // for byte transparency. At the output boundary, we convert valid UTF-8
    // byte sequences back to proper Unicode characters (e.g., CJK, emoji).
    // Invalid UTF-8 (e.g., raw compressed data) is left as binary.
    result.stdout = decodeBinaryToUtf8(result.stdout);
    result.stderr = decodeBinaryToUtf8(result.stderr);
    return result;
  }
  async exec(commandLine, options) {
    if (this.state.callDepth === 0) {
      this.state.commandCount = 0;
    }
    this.state.commandCount++;
    if (this.state.commandCount > this.limits.maxCommandCount) {
      return {
        stdout: "",
        stderr: `bash: maximum command count (${this.limits.maxCommandCount}) exceeded (possible infinite loop). Increase with executionLimits.maxCommandCount option.\n`,
        exitCode: 1,
        env: mapToRecordWithExtras(this.state.env, options?.env),
      };
    }
    if (!commandLine.trim()) {
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        env: mapToRecordWithExtras(this.state.env, options?.env),
      };
    }
    // Log command execution
    this.logger?.info("exec", { command: commandLine });
    // Each exec call gets an isolated state copy - like starting a new shell
    // This ensures exec calls never interfere with each other
    const effectiveCwd = options?.cwd ?? this.state.cwd;
    // Determine PWD and cwd for the new shell context
    // If PWD is in the provided env, use it (inherited from parent)
    // If PWD is NOT in the provided env (was unset), use realpath to get physical path
    // This matches bash behavior: when PWD is unset and a new shell starts,
    // it initializes PWD (and cwd) using realpath (resolving symlinks)
    let newPwd;
    let newCwd = effectiveCwd;
    if (options?.cwd) {
      if (options.env && "PWD" in options.env) {
        // PWD explicitly provided - use it
        newPwd = options.env.PWD;
      } else if (options?.env && !("PWD" in options.env)) {
        // PWD not in provided env - use realpath to resolve symlinks
        // This also updates cwd since the shell determines its position from scratch
        try {
          newPwd = await this.fs.realpath(effectiveCwd);
          newCwd = newPwd; // Both PWD and cwd should be the physical path
        } catch {
          // Fallback to logical path if realpath fails
          newPwd = effectiveCwd;
        }
      } else {
        // No env provided - use logical cwd
        newPwd = effectiveCwd;
      }
    }
    // Create environment for this execution
    const execEnv = options?.replaceEnv ? new Map() : new Map(this.state.env);
    // Merge in options.env
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        execEnv.set(key, value);
      }
    }
    // Update PWD when cwd option is provided
    if (newPwd !== undefined) {
      execEnv.set("PWD", newPwd);
    }
    const execState = {
      ...this.state,
      env: execEnv,
      cwd: newCwd,
      // Deep copy mutable objects to prevent interference
      functions: new Map(this.state.functions),
      localScopes: [...this.state.localScopes],
      options: { ...this.state.options },
      // Share hashTable reference - it should persist across exec calls
      hashTable: this.state.hashTable,
      // Pass stdin through to commands (for bash -c with piped input)
      groupStdin: options?.stdin,
      // Cooperative cancellation signal (used by timeout command)
      signal: options?.signal,
      // Extra arguments injected directly into first command's arg list
      extraArgs: options?.args,
    };
    // Normalize indented multi-line scripts (unless rawScript is true)
    // This allows writing indented bash scripts in template literals
    // BUT we must preserve whitespace inside heredoc content
    let normalized = commandLine;
    if (!options?.rawScript) {
      normalized = normalizeScript(commandLine);
    }
    // Activate defense-in-depth box if configured
    // This wraps execution in AsyncLocalStorage context for context-aware blocking
    const defenseBox = this.defenseInDepthConfig
      ? DefenseInDepthBox.getInstance(this.defenseInDepthConfig)
      : null;
    const defenseHandle = defenseBox?.activate();
    try {
      // Run execution inside defense-in-depth context if enabled
      const executeScript = async () => {
        let ast = parse(normalized, {
          maxHeredocSize: this.limits.maxHeredocSize,
        });
        // Apply transform plugins if any are registered.
        // Keep metadata null-prototype even when plugins contribute dynamic keys.
        let metadata;
        if (this.transformPlugins.length > 0) {
          let meta = Object.create(null);
          for (const plugin of this.transformPlugins) {
            const pluginResult = plugin.transform({ ast, metadata: meta });
            ast = pluginResult.ast;
            if (pluginResult.metadata) {
              meta = mergeToNullPrototype(meta, pluginResult.metadata);
            }
          }
          metadata = meta;
        }
        // Create interpreter with appropriate state
        const interpreterOptions = {
          fs: this.fs,
          commands: this.commands,
          limits: this.limits,
          exec: this.exec.bind(this),
          fetch: this.secureFetch,
          sleep: this.sleepFn,
          trace: this.traceFn,
          coverage: this.coverageWriter,
          requireDefenseContext: defenseBox?.isEnabled() === true,
          jsBootstrapCode: this.jsBootstrapCode,
        };
        const interpreter = new Interpreter(interpreterOptions, execState);
        const result = await interpreter.executeScript(ast);
        // Interpreter always sets env, assert it for type safety
        const execResult = result;
        if (metadata) {
          execResult.metadata = metadata;
        }
        return this.logResult(execResult);
      };
      // If defense-in-depth is enabled, run within the protected context
      if (defenseHandle) {
        return await defenseHandle.run(executeScript);
      }
      return await executeScript();
    } catch (error) {
      // ExitError propagates from 'exit' builtin (including via eval/source)
      if (error instanceof ExitError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode,
          env: mapToRecordWithExtras(this.state.env, options?.env),
        });
      }
      // PosixFatalError propagates from special builtins in POSIX mode
      if (error instanceof PosixFatalError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode,
          env: mapToRecordWithExtras(this.state.env, options?.env),
        });
      }
      if (error instanceof ArithmeticError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: 1,
          env: mapToRecordWithExtras(this.state.env, options?.env),
        });
      }
      // ExecutionAbortedError is thrown when an AbortSignal fires (timeout cancellation)
      if (error instanceof ExecutionAbortedError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: 124, // Same as timeout exit code
          env: mapToRecordWithExtras(this.state.env, options?.env),
        });
      }
      // ExecutionLimitError is thrown when our conservative limits are exceeded
      // (command count, recursion depth, loop iterations)
      if (error instanceof ExecutionLimitError) {
        return this.logResult({
          stdout: error.stdout,
          stderr: sanitizeErrorMessage(error.stderr),
          exitCode: ExecutionLimitError.EXIT_CODE,
          env: mapToRecordWithExtras(this.state.env, options?.env),
        });
      }
      // SecurityViolationError is thrown when defense-in-depth detects a blocked operation
      if (error instanceof SecurityViolationError) {
        return this.logResult({
          stdout: "",
          stderr: `bash: security violation: ${sanitizeErrorMessage(error.message)}\n`,
          exitCode: 1,
          env: mapToRecordWithExtras(this.state.env, options?.env),
        });
      }
      if (error.name === "ParseException") {
        return this.logResult({
          stdout: "",
          stderr: `bash: syntax error: ${sanitizeErrorMessage(error.message)}\n`,
          exitCode: 2,
          env: mapToRecordWithExtras(this.state.env, options?.env),
        });
      }
      // LexerError is thrown for lexer-level issues like unterminated quotes
      if (error instanceof LexerError) {
        return this.logResult({
          stdout: "",
          stderr: `bash: ${sanitizeErrorMessage(error.message)}\n`,
          exitCode: 2,
          env: mapToRecordWithExtras(this.state.env, options?.env),
        });
      }
      // RangeError occurs when JavaScript call stack is exceeded (deep recursion)
      if (error instanceof RangeError) {
        return this.logResult({
          stdout: "",
          stderr: `bash: ${sanitizeErrorMessage(error.message)}\n`,
          exitCode: 1,
          env: mapToRecordWithExtras(this.state.env, options?.env),
        });
      }
      throw error;
    } finally {
      // Always deactivate defense-in-depth box when done
      defenseHandle?.deactivate();
    }
  }
  // ===========================================================================
  // PUBLIC API
  // ===========================================================================
  async readFile(path) {
    return this.fs.readFile(this.fs.resolvePath(this.state.cwd, path));
  }
  async writeFile(path, content) {
    return this.fs.writeFile(
      this.fs.resolvePath(this.state.cwd, path),
      content,
    );
  }
  getCwd() {
    return this.state.cwd;
  }
  getEnv() {
    return mapToRecord(this.state.env);
  }
  // biome-ignore lint/suspicious/noExplicitAny: accepts any plugin for untyped API
  registerTransformPlugin(plugin) {
    this.transformPlugins.push(plugin);
  }
  transform(commandLine) {
    const normalized = normalizeScript(commandLine);
    let ast = parse(normalized, {
      maxHeredocSize: this.limits.maxHeredocSize,
    });
    let metadata = Object.create(null);
    for (const plugin of this.transformPlugins) {
      const result = plugin.transform({ ast, metadata });
      ast = result.ast;
      if (result.metadata) {
        metadata = mergeToNullPrototype(metadata, result.metadata);
      }
    }
    return {
      script: serialize(ast),
      ast,
      metadata,
    };
  }
}
/**
 * Normalize a script by stripping leading whitespace from lines,
 * while preserving whitespace inside heredoc content.
 *
 * This allows writing indented bash scripts in template literals:
 * ```
 * await bash.exec(`
 *   if [ -f foo ]; then
 *     echo "yes"
 *   fi
 * `);
 * ```
 *
 * Heredocs are detected by looking for << or <<- operators and their delimiters.
 */
function normalizeScript(script) {
  const lines = script.split("\n");
  const result = [];
  // Stack of pending heredoc delimiters (for nested heredocs)
  const pendingDelimiters = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // If we're inside a heredoc, check if this line ends it
    if (pendingDelimiters.length > 0) {
      const current = pendingDelimiters[pendingDelimiters.length - 1];
      // For <<-, strip leading tabs when checking delimiter
      // For <<, require exact match (no leading whitespace allowed)
      const lineToCheck = current.stripTabs ? line.replace(/^\t+/, "") : line;
      if (lineToCheck === current.delimiter) {
        // End of heredoc - this line can be normalized
        result.push(line.trimStart());
        pendingDelimiters.pop();
        continue;
      }
      // Inside heredoc - preserve the line exactly as-is
      result.push(line);
      continue;
    }
    // Not inside a heredoc - normalize the line and check for heredoc starts
    const normalizedLine = line.trimStart();
    result.push(normalizedLine);
    // Check for heredoc operators in this line
    // Match: <<DELIM, <<-DELIM, << 'DELIM', <<- "DELIM", etc.
    // Multiple heredocs on one line are possible: cmd <<EOF1 <<EOF2
    const heredocPattern = /<<(-?)\s*(['"]?)([\w-]+)\2/g;
    for (const match of normalizedLine.matchAll(heredocPattern)) {
      const stripTabs = match[1] === "-";
      const delimiter = match[3];
      pendingDelimiters.push({ delimiter, stripTabs });
    }
  }
  return result.join("\n");
}
/**
 * Strict UTF-8 decoder that throws on invalid byte sequences.
 */
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
/**
 * Decode a binary string (latin1, where each char = one byte) to UTF-8.
 *
 * The internal pipeline uses binary strings for byte transparency (e.g.,
 * piping compressed data through cat). At the output boundary, we convert
 * valid UTF-8 byte sequences back to proper Unicode characters so that
 * multibyte text (CJK, Cyrillic, emoji) displays correctly.
 *
 * If the binary string does not contain valid UTF-8, it is returned as-is.
 */
function decodeBinaryToUtf8(s) {
  if (!s) return s;
  // Scan the string to determine its type:
  // - All chars ≤ 0x7F: pure ASCII, no conversion needed
  // - Any char > 0xFF: already proper Unicode (from commands like printf, grep),
  //   not a binary string — return as-is
  // - Chars in 0x80-0xFF range only: binary string (latin1) that may contain
  //   UTF-8 byte sequences — try decoding
  let hasHighByte = false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0xff) {
      // Already a proper Unicode string, not a binary string
      return s;
    }
    if (code > 0x7f) {
      hasHighByte = true;
    }
  }
  if (!hasHighByte) return s;
  // Convert binary string to bytes
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i);
  }
  // Try UTF-8 decoding; fall back to binary string for non-UTF-8 data
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch {
    return s;
  }
}
