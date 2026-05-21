import { failure, OK } from "../helpers/result.js";
import type { InterpreterContext } from "../types.js";

const VALID_SIGNALS = new Set([
  "EXIT",
  "ERR",
  "DEBUG",
  "RETURN",
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGQUIT",
  "INT",
  "TERM",
  "HUP",
  "QUIT",
]);

const SIGNAL_NAMES = [
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
];

function normalizeSignal(sig: string): string {
  const upper = sig.toUpperCase();
  if (upper === "0") return "EXIT";
  if (upper === "INT") return "SIGINT";
  if (upper === "TERM") return "SIGTERM";
  if (upper === "HUP") return "SIGHUP";
  if (upper === "QUIT") return "SIGQUIT";
  return upper;
}

function printTraps(ctx: InterpreterContext, signals?: string[]): string {
  const handlers = ctx.state.trapHandlers;
  if (!handlers || handlers.size === 0) return "";

  let output = "";
  if (signals && signals.length > 0) {
    for (const sig of signals) {
      const normalized = normalizeSignal(sig);
      const handler = handlers.get(normalized);
      if (handler !== undefined) {
        output += `trap -- '${handler.replace(/'/g, "'\\''")}' ${normalized}\n`;
      }
    }
  } else {
    for (const [signal, handler] of handlers) {
      output += `trap -- '${handler.replace(/'/g, "'\\''")}' ${signal}\n`;
    }
  }
  return output;
}

export function handleTrap(
  ctx: InterpreterContext,
  args: string[],
): { stdout: string; stderr: string; exitCode: number } {
  if (args.length === 0) {
    const output = printTraps(ctx);
    return { stdout: output, stderr: "", exitCode: 0 };
  }

  if (args[0] === "-l") {
    let output = "";
    for (let i = 0; i < SIGNAL_NAMES.length; i++) {
      output += `${String(i + 1).padStart(2)}) ${SIGNAL_NAMES[i]}`;
      if ((i + 1) % 5 === 0) {
        output += "\n";
      } else if (i < SIGNAL_NAMES.length - 1) {
        output += "\t";
      }
    }
    if (!output.endsWith("\n")) output += "\n";
    return { stdout: output, stderr: "", exitCode: 0 };
  }

  if (args[0] === "-p") {
    const signals = args.slice(1);
    const output = printTraps(ctx, signals.length > 0 ? signals : undefined);
    return { stdout: output, stderr: "", exitCode: 0 };
  }

  if (args.length === 1) {
    const sig = normalizeSignal(args[0]);
    if (!VALID_SIGNALS.has(sig) && sig !== "EXIT") {
      return failure(`bash: trap: ${args[0]}: invalid signal specification\n`);
    }
    const output = printTraps(ctx, [args[0]]);
    return { stdout: output, stderr: "", exitCode: 0 };
  }

  const command = args[0];
  const signals = args.slice(1);

  for (const sig of signals) {
    const normalized = normalizeSignal(sig);
    if (!VALID_SIGNALS.has(normalized) && normalized !== "EXIT") {
      return failure(`bash: trap: ${sig}: invalid signal specification\n`);
    }

    if (command === "-") {
      if (ctx.state.trapHandlers) {
        ctx.state.trapHandlers.delete(normalized);
      }
    } else {
      if (!ctx.state.trapHandlers) {
        ctx.state.trapHandlers = new Map<string, string>();
      }
      ctx.state.trapHandlers.set(normalized, command);
    }
  }

  return OK;
}
