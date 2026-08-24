import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import { getErrorMessage } from "../../interpreter/helpers/errors.js";
import { SecurityViolationError } from "../../security/defense-in-depth-box.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";

const argDefs = {
  recursive: { short: "r", long: "recursive", type: "boolean" as const },
  recursiveUpper: { short: "R", type: "boolean" as const },
  force: { short: "f", long: "force", type: "boolean" as const },
  verbose: { short: "v", long: "verbose", type: "boolean" as const },
};

/**
 * Recognize a security denial without trusting `instanceof` alone.
 *
 * `dist` ships both an ESM and a CJS bundle, so two copies of the error class
 * can coexist in one process and cross-realm `instanceof` then returns false.
 * The own-property `name` check covers that: `SecurityViolationError`'s
 * constructor assigns `name`, and `interpreter/defense-aware-command-context.ts`
 * — the layer that denies writes in plan mode — assigns it a second time
 * explicitly so this check works. The interpreter's own error boundaries pair
 * the two checks for this error for the same reason.
 *
 * `Object.hasOwn` rather than a bare read, so polluting `Object.prototype.name`
 * cannot brand unrelated errors as security violations.
 */
function isSecurityViolation(error: unknown): boolean {
  if (error instanceof SecurityViolationError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    Object.hasOwn(error, "name") &&
    (error as { name?: unknown }).name === "SecurityViolationError"
  );
}

/**
 * Read a Node-style errno (`err.code === "ENOENT"`) when the thrown value
 * carries one. The virtual filesystems throw plain `Error`s whose message
 * starts with the errno instead, so `undefined` here means "fall back to the
 * message".
 */
function readErrnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!Object.hasOwn(error, "code")) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * True only when the failure means "the target does not exist" — the one
 * failure POSIX lets `rm -f` suppress.
 *
 * Fail-closed by construction: anything not positively recognized as a missing
 * target is reported. A security denial is rejected up front, before the
 * message heuristic, so a violation whose text happens to contain "ENOENT" can
 * never be silently dropped.
 */
function isMissingTargetError(error: unknown): boolean {
  if (isSecurityViolation(error)) return false;

  const code = readErrnoCode(error);
  if (code !== undefined) return code === "ENOENT";

  const message = getErrorMessage(error);
  return message.includes("ENOENT") || message.includes("no such file");
}

export const rmCommand: Command = {
  name: "rm",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const parsed = parseArgs("rm", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const recursive =
      parsed.result.flags.recursive || parsed.result.flags.recursiveUpper;
    const force = parsed.result.flags.force;
    const verbose = parsed.result.flags.verbose;
    const paths = parsed.result.positional;

    if (paths.length === 0) {
      if (force) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return {
        stdout: "",
        stderr: "rm: missing operand\n",
        exitCode: 1,
      };
    }

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    for (const path of paths) {
      try {
        const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
        const stat = await ctx.fs.stat(fullPath);
        if (stat.isDirectory && !recursive) {
          stderr += `rm: cannot remove '${path}': Is a directory\n`;
          exitCode = 1;
          continue;
        }
        await ctx.fs.rm(fullPath, { recursive, force });
        if (verbose) {
          stdout += `removed '${path}'\n`;
        }
      } catch (error) {
        // `-f` ignores nonexistent operands (POSIX) and NOTHING else. A
        // security denial, EACCES or EROFS reaching here means the unlink did
        // not happen, so suppressing it would report a removal that never
        // occurred — the caller, human or agent, believes the file is gone.
        const isMissingTarget = isMissingTargetError(error);
        if (!force || !isMissingTarget) {
          const message = getErrorMessage(error);
          if (isMissingTarget) {
            stderr += `rm: cannot remove '${path}': No such file or directory\n`;
          } else if (
            message.includes("ENOTEMPTY") ||
            message.includes("not empty")
          ) {
            stderr += `rm: cannot remove '${path}': Directory not empty\n`;
          } else {
            stderr += `rm: cannot remove '${path}': ${sanitizeErrorMessage(message)}\n`;
          }
          exitCode = 1;
        }
      }
    }

    return { stdout, stderr, exitCode };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "rm",
  flags: [
    { flag: "-r", type: "boolean" },
    { flag: "-R", type: "boolean" },
    { flag: "-f", type: "boolean" },
    { flag: "-v", type: "boolean" },
  ],
  needsArgs: true,
};
