import type { CustomCommand } from "../custom-commands.js";

/**
 * Helper commands for the Bash spec tests.
 * These are used by the test runner to provide extra functionality
 * inside the bash sandbox during Oils spec tests.
 */
export const testHelperCommands: CustomCommand[] = [
  // Empty for now to satisfy the build, can be populated with specific test mocks as needed
];
