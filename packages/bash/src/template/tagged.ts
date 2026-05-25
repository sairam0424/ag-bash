import type { BashOptions } from "../Bash.js";
import { Bash } from "../Bash.js";
import type { ExecResult } from "../types.js";
import { shellEscape } from "./escape.js";

export interface TaggedShell {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<ExecResult>;
  /** Access the underlying Bash instance */
  readonly bash: Bash;
  /** Change working directory for subsequent commands */
  cd(path: string): Promise<void>;
}

/**
 * Create a tagged template shell for ergonomic bash execution.
 *
 * @example
 * ```ts
 * const $ = createShell();
 * const result = await $`echo hello ${name}`;
 * console.log(result.stdout); // "hello world\n"
 * ```
 */
export function createShell(options?: BashOptions): TaggedShell {
  const bash = new Bash({
    persistState: true,
    ...options,
  });

  const shell = async function (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<ExecResult> {
    let command = strings[0];
    for (let i = 0; i < values.length; i++) {
      command += shellEscape(values[i]);
      command += strings[i + 1];
    }
    return bash.exec(command);
  } as TaggedShell;

  Object.defineProperty(shell, "bash", {
    get: () => bash,
    enumerable: true,
  });

  shell.cd = async (path: string): Promise<void> => {
    const result = await bash.exec(`cd ${shellEscape(path)}`);
    if (result.exitCode !== 0) {
      throw new Error(`cd: ${path}: ${result.stderr}`);
    }
  };

  return shell;
}
