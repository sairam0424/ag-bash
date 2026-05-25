import { Bash } from "../Bash.js";
import type { BashOptions } from "../Bash.js";
import type { InitialFiles } from "../fs/interface.js";

export interface TestBashOptions {
  /** Initial files to populate the virtual filesystem with. */
  files?: InitialFiles;
  /** Environment variables to set in the test shell. */
  env?: Record<string, string>;
  /** Initial working directory. Defaults to '/home/user'. */
  cwd?: string;
}

/**
 * Creates a Bash instance pre-configured for fast testing:
 * - No defense-in-depth (faster execution)
 * - Short execution limits
 * - persistState: true (state survives between exec calls)
 * - No network access
 *
 * @example
 * ```ts
 * const bash = createTestBash({
 *   files: { '/project/main.ts': 'console.log("hi");\n' },
 *   cwd: '/project',
 * });
 * const result = await bash.exec('cat main.ts');
 * ```
 */
export function createTestBash(options?: TestBashOptions): Bash {
  const bashOpts: BashOptions = {
    files: options?.files,
    cwd: options?.cwd ?? "/home/user",
    env: {
      HOME: "/home/user",
      PATH: "/usr/bin:/bin",
      USER: "testuser",
      ...options?.env,
    },
    persistState: true,
    security: {
      defenseInDepth: false,
    },
    executionLimits: {
      maxCpuMs: 5000,
      maxCommandCount: 1000,
      maxLoopIterations: 1000,
      maxOutputSize: 1_000_000,
    },
  };

  return new Bash(bashOpts);
}
