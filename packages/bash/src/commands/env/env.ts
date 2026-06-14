import { mapToRecord } from "../../helpers/env.js";
import { shellJoinArgs } from "../../helpers/shell-quote.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import { hasHelpFlag, showHelp, unknownOption } from "../help.js";

const envHelp = {
  name: "env",
  summary: "run a program in a modified environment",
  usage: "env [OPTION]... [NAME=VALUE]... [COMMAND [ARG]...]",
  options: [
    "-i, --ignore-environment  start with an empty environment",
    "-u NAME, --unset=NAME     remove NAME from the environment",
    "    --help                display this help and exit",
  ],
};

export const envCommand: Command = {
  name: "env",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(envHelp);
    }

    let ignoreEnv = false;
    const unsetVars: string[] = [];
    const setVars = new Map<string, string>();
    let commandStart = -1;

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === "-i" || arg === "--ignore-environment") {
        ignoreEnv = true;
      } else if (arg === "-u" && i + 1 < args.length) {
        unsetVars.push(args[++i]);
      } else if (arg.startsWith("-u")) {
        unsetVars.push(arg.slice(2));
      } else if (arg.startsWith("--unset=")) {
        unsetVars.push(arg.slice(8));
      } else if (arg.startsWith("--") && arg !== "--") {
        return unknownOption("env", arg);
      } else if (arg.startsWith("-") && arg !== "-") {
        // Check for unknown single-char options
        for (const c of arg.slice(1)) {
          if (c !== "i" && c !== "u") {
            return unknownOption("env", `-${c}`);
          }
        }
        if (arg.includes("i")) ignoreEnv = true;
      } else if (arg.includes("=") && commandStart === -1) {
        // NAME=VALUE assignment
        const eqIdx = arg.indexOf("=");
        const name = arg.slice(0, eqIdx);
        const value = arg.slice(eqIdx + 1);
        setVars.set(name, value);
      } else {
        // Start of command
        commandStart = i;
        break;
      }
    }

    // Build the new environment
    let newEnv: Map<string, string>;
    if (ignoreEnv) {
      newEnv = new Map(setVars);
    } else {
      newEnv = new Map(ctx.env);
      // Unset variables
      for (const name of unsetVars) {
        newEnv.delete(name);
      }
      // Set new variables
      for (const [name, value] of setVars) {
        newEnv.set(name, value);
      }
    }

    // If no command, just print environment
    if (commandStart === -1) {
      const lines: string[] = [];
      for (const [key, value] of newEnv) {
        lines.push(`${key}=${value}`);
      }
      return {
        stdout: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0,
      };
    }

    // Execute command with modified environment
    if (!ctx.exec) {
      return {
        stdout: "",
        stderr: "env: command execution not supported in this context\n",
        exitCode: 1,
      };
    }

    // The first non-assignment argument NAMES a program to execute; the rest
    // are its argv. Build a `command <argv>` script.
    //
    // - The `command` prefix bypasses shell keywords/functions (e.g. `time`),
    //   so env runs the real external program, matching bash.
    // - Every token is single-quoted via shellJoinArgs, making each argv a
    //   single literal shell word. Shell metacharacters in untrusted values
    //   (e.g. `echo X > /tmp/m ; #`) can never be reparsed as shell source —
    //   the whole token becomes one literal command name.
    const cmdArgs = args.slice(commandStart);
    const programName = cmdArgs[0];
    const script = `command ${shellJoinArgs(cmdArgs)}`;

    const result = await ctx.exec(script, {
      cwd: ctx.cwd,
      env: mapToRecord(newEnv),
      replaceEnv: true,
      stdin: ctx.stdin,
      signal: ctx.signal,
    });

    return rewriteLaunchFailure(result, programName);
  },
};

/**
 * Map a launch failure of the named program to env's own diagnostics.
 *
 * When env cannot start the requested program, GNU/BSD `env` reports the
 * failure itself (exit 127 for "not found", 126 for "permission denied")
 * rather than passing through the shell's message. The `command` builtin
 * emits a recognizable `bash: <name>: <reason>` line ONLY when it fails to
 * resolve/launch that program — if the program runs and exits non-zero on its
 * own, no such line is produced, and we forward the status untouched.
 *
 * Oracle (host bash):
 *   env 'echo X ; #'      -> exit 127, "env: echo X ; #: No such file or directory"
 *   env /some/dir         -> exit 126, "env: /some/dir: Permission denied"
 *   env false             -> exit 1,   (no env: diagnostic)
 */
function rewriteLaunchFailure(
  result: ExecResult,
  programName: string,
): ExecResult {
  if (result.exitCode !== 127 && result.exitCode !== 126) {
    return result;
  }

  const notFound = `bash: ${programName}: command not found\n`;
  const noSuchFile = `bash: ${programName}: No such file or directory\n`;
  const permDenied = `bash: ${programName}: Permission denied\n`;

  let envStderr: string | undefined;
  if (result.stderr === notFound || result.stderr === noSuchFile) {
    // env reports a missing program as "No such file or directory".
    envStderr = `env: ${programName}: No such file or directory\n`;
  } else if (result.stderr === permDenied) {
    envStderr = `env: ${programName}: Permission denied\n`;
  }

  if (envStderr === undefined) {
    // The program launched and exited with this status itself — pass through.
    return result;
  }

  return { ...result, stderr: envStderr };
}

const printenvHelp = {
  name: "printenv",
  summary: "print all or part of environment",
  usage: "printenv [OPTION]... [VARIABLE]...",
  options: ["    --help       display this help and exit"],
};

export const printenvCommand: Command = {
  name: "printenv",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(printenvHelp);
    }

    const vars = args.filter((arg) => !arg.startsWith("-"));

    if (vars.length === 0) {
      // Print all
      const lines: string[] = [];
      for (const [key, value] of ctx.env) {
        lines.push(`${key}=${value}`);
      }
      return {
        stdout: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0,
      };
    }

    // Print specific variables
    const lines: string[] = [];
    let exitCode = 0;
    for (const varName of vars) {
      const value = ctx.env.get(varName);
      if (value !== undefined) {
        lines.push(value);
      } else {
        exitCode = 1;
      }
    }

    return {
      stdout: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
      stderr: "",
      exitCode,
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "env",
  flags: [
    { flag: "-i", type: "boolean" },
    { flag: "-u", type: "value", valueHint: "string" },
  ],
};

export const printenvFlagsForFuzzing: CommandFuzzInfo = {
  name: "printenv",
  flags: [],
};
