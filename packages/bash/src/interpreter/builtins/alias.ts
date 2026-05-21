import type { ExecResult } from "../../types.js";
import { failure, OK, success } from "../helpers/result.js";
import type { InterpreterContext } from "../types.js";

const ALIAS_PREFIX = "BASH_ALIAS_";

const ALIAS_HELP =
  "alias: alias [name[=value] ...]\n    Define or display aliases.\n";
const UNALIAS_HELP =
  "unalias: unalias [-a] name [name ...]\n    Remove alias definitions.\n";

export function handleAlias(
  ctx: InterpreterContext,
  args: string[],
): ExecResult {
  if (args.length === 1 && args[0] === "--help") {
    return success(ALIAS_HELP);
  }

  if (args.length === 0) {
    let stdout = "";
    for (const [key, value] of ctx.state.env) {
      if (key.startsWith(ALIAS_PREFIX)) {
        const name = key.slice(ALIAS_PREFIX.length);
        stdout += `alias ${name}='${value.replace(/'/g, "'\\''")}'\n`;
      }
    }
    return success(stdout);
  }

  let exitCode = 0;
  let stdout = "";
  let stderr = "";

  for (const arg of args) {
    const eqIndex = arg.indexOf("=");
    if (eqIndex === -1) {
      const value = ctx.state.env.get(`${ALIAS_PREFIX}${arg}`);
      if (value === undefined) {
        stderr += `bash: alias: ${arg}: not found\n`;
        exitCode = 1;
      } else {
        stdout += `alias ${arg}='${value.replace(/'/g, "'\\''")}'\n`;
      }
    } else {
      const name = arg.slice(0, eqIndex);
      const value = arg.slice(eqIndex + 1);
      ctx.state.env.set(`${ALIAS_PREFIX}${name}`, value);
    }
  }

  if (exitCode !== 0) {
    return { exitCode, stdout, stderr };
  }
  if (stdout) {
    return success(stdout);
  }
  return OK;
}

export function handleUnalias(
  ctx: InterpreterContext,
  args: string[],
): ExecResult {
  if (args.length === 1 && args[0] === "--help") {
    return success(UNALIAS_HELP);
  }

  if (args.length === 0) {
    return failure("bash: unalias: usage: unalias [-a] name [name ...]\n", 2);
  }

  if (args[0] === "-a") {
    const keysToDelete: string[] = [];
    for (const key of ctx.state.env.keys()) {
      if (key.startsWith(ALIAS_PREFIX)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      ctx.state.env.delete(key);
    }
    return OK;
  }

  let exitCode = 0;
  let stderr = "";

  for (const name of args) {
    const key = `${ALIAS_PREFIX}${name}`;
    if (!ctx.state.env.has(key)) {
      stderr += `bash: unalias: ${name}: not found\n`;
      exitCode = 1;
    } else {
      ctx.state.env.delete(key);
    }
  }

  if (exitCode !== 0) {
    return { exitCode, stdout: "", stderr };
  }
  return OK;
}
