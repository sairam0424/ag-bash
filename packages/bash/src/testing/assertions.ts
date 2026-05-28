import type { Bash } from "../Bash.js";
import type { ExecResult } from "../types.js";

/**
 * Asserts that the result exited with code 0 and returns stdout.
 * Throws with stderr details on failure.
 */
export function assertSuccess(result: ExecResult): string {
  if (result.exitCode !== 0) {
    throw new Error(
      `Expected exit code 0, got ${result.exitCode}.\nStderr: ${result.stderr}`,
    );
  }
  return result.stdout;
}

/**
 * Asserts that the result exited with a non-zero code.
 * Optionally checks for a specific exit code or a regex pattern against stderr.
 *
 * @param result - The execution result (or a Promise resolving to one)
 * @param expected - If a number, asserts that specific exit code. If a RegExp, asserts stderr matches.
 *
 * @example
 * ```ts
 * // Assert any failure
 * await assertFails(bash.exec("false"));
 *
 * // Assert specific exit code
 * await assertFails(bash.exec("exit 2"), 2);
 *
 * // Assert stderr matches a pattern
 * await assertFails(bash.exec("cat /no/such/file"), /No such file/);
 * ```
 */
export async function assertFails(
  result: ExecResult | Promise<ExecResult>,
  expected?: number | RegExp,
): Promise<void> {
  const r = await result;
  if (r.exitCode === 0) {
    throw new Error(
      `Expected failure but got success. stdout: ${r.stdout}`,
    );
  }
  if (typeof expected === "number" && r.exitCode !== expected) {
    throw new Error(
      `Expected exit code ${expected} but got ${r.exitCode}`,
    );
  }
  if (expected instanceof RegExp && !expected.test(r.stderr)) {
    throw new Error(
      `Expected stderr to match ${expected} but got: ${r.stderr}`,
    );
  }
}

/**
 * Asserts that stdout contains the given substring.
 */
export function assertOutput(result: ExecResult, substring: string): void {
  if (!result.stdout.includes(substring)) {
    throw new Error(
      `Expected stdout to contain "${substring}".\nActual: ${result.stdout}`,
    );
  }
}

/**
 * Asserts that stderr contains the given substring.
 */
export function assertStderr(result: ExecResult, substring: string): void {
  if (!result.stderr.includes(substring)) {
    throw new Error(
      `Expected stderr to contain "${substring}".\nActual: ${result.stderr}`,
    );
  }
}

/**
 * Asserts that a file exists in the bash filesystem.
 * Optionally checks that the file content matches exactly.
 *
 * Note: Uses the Bash.exec method (ag-bash virtual shell), not child_process.
 */
export async function assertFileExists(
  bash: Bash,
  path: string,
  expectedContent?: string,
): Promise<void> {
  const result = await bash.exec(`cat "${path}"`);
  if (result.exitCode !== 0) {
    throw new Error(`File ${path} does not exist`);
  }
  if (expectedContent !== undefined && result.stdout !== expectedContent) {
    throw new Error(
      `File ${path} content mismatch.\nExpected: ${expectedContent}\nActual: ${result.stdout}`,
    );
  }
}

/**
 * Asserts that a file does NOT exist in the bash filesystem.
 *
 * Note: Uses the Bash.exec method (ag-bash virtual shell), not child_process.
 */
export async function assertFileNotExists(
  bash: Bash,
  path: string,
): Promise<void> {
  const result = await bash.exec(`test -f "${path}"`);
  if (result.exitCode === 0) {
    throw new Error(`File ${path} exists but should not`);
  }
}
