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
        // 1. Convert to UTF-8 bytes and escape non-ASCII / non-printable
        // 2. Escape backslashes
        // 3. Choice of ' or " based on contents
        
        const encoder = new TextEncoder();
        const bytes = encoder.encode(arg);
        let result = "";
        let hasSingleQuote = false;
        let hasDoubleQuote = false;
        
        for (const b of bytes) {
          if (b === 39) hasSingleQuote = true; // '
          if (b === 34) hasDoubleQuote = true; // "
          
          if (b === 92) { // \
            result += "\\\\";
          } else if (b === 39) { // '
            result += "'";
          } else if (b === 10) { // \n
            result += "\\n";
          } else if (b === 13) { // \r
            result += "\\r";
          } else if (b === 9) { // \t
            result += "\\t";
          } else if (b >= 32 && b <= 126) {
            result += String.fromCharCode(b);
          } else {
            // Hex escape for non-ASCII
            result += "\\x" + b.toString(16).padStart(2, "0");
          }
        }
        
        if (hasSingleQuote && !hasDoubleQuote) {
          return `"${result}"`;
        }
        return `'${result.replace(/'/g, "\\'")}'`;
      });

      const formatted = `[${formattedItems.join(", ")}]`;
      return {
        stdout: formatted + "\n",
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
        stdout: output + "\n",
        stderr: "",
        exitCode: 0,
      };
    },
  },
  {
    name: "stdout_stderr.py",
    execute: async () => {
      return {
        stdout: "STDOUT\n",
        stderr: "STDERR\n",
        exitCode: 0,
      };
    },
  },
  {
    name: "read_from_fd.py",
    execute: async (args: string[]) => {
      // read_from_fd.py <fd1> <fd2> ...
      // Reads from specified FDs and prints formatted output
      // Note: Ag-Bash IFileSystem currently doesn't expose raw FD reading to commands.
      // This is a placeholder for here-doc tests that require it.
      return {
        stdout: "", 
        stderr: "read_from_fd.py: FD reading not yet supported in this environment\n",
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
