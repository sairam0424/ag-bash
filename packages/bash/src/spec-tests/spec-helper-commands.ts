import type { Command, CommandContext } from "../types.js";

/**
 * Helper commands for the Bash spec tests.
 * These are used by the test runner to provide extra functionality
 * inside the bash sandbox during Oils spec tests.
 */
export const testHelperCommands: Command[] = [
  {
    name: "argv.py",
    execute: async (args: string[]) => {
      // Oils spec tests expect a Python-style list representation of arguments
      // using Python's repr() logic for strings.
      const formattedItems = args.map((arg) => {
        // Python repr() logic for strings:
        // Use manual charCode mapping to maintain binary transparency for Ag-Bash strings.
        // JS strings in the interpreter use 1 char per byte for binary data from printf etc.
        // Characters > 255 are treated as Unicode and encoded to UTF-8 bytes.
        const bytes: number[] = [];
        for (let i = 0; i < arg.length; i++) {
          const code = arg.charCodeAt(i);
          if (code < 256) {
            bytes.push(code);
          } else {
            const encoded = new TextEncoder().encode(arg[i]);
            for (let j = 0; j < encoded.length; j++) {
              bytes.push(encoded[j]);
            }
          }
        }

        let result = "";
        let hasSingleQuote = false;
        let hasDoubleQuote = false;

        for (const b of bytes) {
          if (b === 39) hasSingleQuote = true; // '
          if (b === 34) hasDoubleQuote = true; // "

          if (b === 92) {
            // \
            result += "\\\\";
          } else if (b === 39) {
            // '
            result += "'";
          } else if (b === 10) {
            // \n
            result += "\\n";
          } else if (b === 13) {
            // \r
            result += "\\r";
          } else if (b === 9) {
            // \t
            result += "\\t";
          } else if (b >= 32 && b <= 126) {
            result += String.fromCharCode(b);
          } else {
            // Hex escape for non-ASCII
            result += `\\x${b.toString(16).padStart(2, "0")}`;
          }
        }

        if (hasSingleQuote && !hasDoubleQuote) {
          return `"${result}"`;
        }
        return `'${result.replace(/'/g, "\\'")}'`;
      });

      const formatted = `[${formattedItems.join(", ")}]`;
      return {
        stdout: `${formatted}\n`,
        stderr: "",
        exitCode: 0,
      };
    },
  },
  {
    name: "printenv.py",
    execute: async (args: string[], context: CommandContext) => {
      // Oils printenv.py prints 'None' if variable is not set
      // It should only show EXPORTED variables.
      const envRec = context.exportedEnv || Object.create(null);

      if (args.length === 0) {
        const output = Object.entries(envRec)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n");
        return {
          stdout: output + (output ? "\n" : ""),
          stderr: "",
          exitCode: 0,
        };
      }
      const output = args
        .map((name) => {
          const val = envRec[name];
          return val === undefined ? "None" : val;
        })
        .join("\n");
      return {
        stdout: `${output}\n`,
        stderr: "",
        exitCode: 0,
      };
    },
  },
  {
    name: "stdout_stderr.py",
    execute: async (args: string[]) => {
      return {
        stdout: args.length > 0 ? args[0] : "STDOUT\n",
        stderr: "STDERR\n",
        exitCode: 0,
      };
    },
  },
  {
    name: "read_from_fd.py",
    execute: async (args: string[], context: CommandContext) => {
      // read_from_fd.py <fd1> <fd2> ...
      // Reads from specified FDs and prints formatted output
      let stdout = "";
      for (const arg of args) {
        const fd = Number(arg);
        let content = context.fileDescriptors?.get(fd);
        // Special case for stdin (FD 0) if not in the map
        if (fd === 0 && content === undefined) {
          content = context.stdin;
        }
        if (content !== undefined) {
          stdout += `${fd}: ${content.trimEnd()}\n`;
        }
      }
      return {
        stdout,
        stderr: "",
        exitCode: 0,
      };
    },
  },
  {
    name: "id_kind.py",
    execute: async (args: string[]) => {
      // Dummy id_kind.py for Oils tests
      return {
        stdout: `member ${args[0] || ""}\n`,
        stderr: "",
        exitCode: 0,
      };
    },
  },
];
