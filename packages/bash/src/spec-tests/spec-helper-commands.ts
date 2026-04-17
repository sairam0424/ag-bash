import type { CustomCommand } from "../custom-commands.js";

/**
 * Helper commands for the Bash spec tests.
 * These are used by the test runner to provide extra functionality
 * inside the bash sandbox during Oils spec tests.
 */
export const testHelperCommands: CustomCommand[] = [
  {
    name: "argv.py",
    run: async (args) => {
      // Oils spec tests expect a Python-style list representation of arguments
      // e.g. ['arg1', 'arg2']
      const formatted = JSON.stringify(args).replace(/"/g, "'");
      return {
        stdout: formatted + "\n",
        stderr: "",
        exitCode: 0,
      };
    },
  },
  {
    name: "printenv.py",
    run: async (args, context) => {
      if (args.length === 0) {
        // Return all env vars
        const output = Object.entries(context.env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n");
        return {
          stdout: output + (output ? "\n" : ""),
          stderr: "",
          exitCode: 0,
        };
      }
      // Return specific env vars
      const output = args.map((name) => context.env[name] || "").join("\n");
      return {
        stdout: output + "\n",
        stderr: "",
        exitCode: 0,
      };
    },
  },
  {
    name: "stdout_stderr.py",
    run: async () => {
      return {
        stdout: "STDOUT\n",
        stderr: "STDERR\n",
        exitCode: 0,
      };
    },
  },
];
