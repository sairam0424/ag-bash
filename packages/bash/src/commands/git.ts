/**
 * git implementation for Ag-Bash
 *
 * This command uses isomorphic-git to provide a sandboxed git environment
 * that works directly with the Ag-Bash IFileSystem.
 */

import type { Command, CommandContext, ExecResult } from "../types.js";

export const gitCommand: Command = {
  name: "git",
  async execute(args: string[], context: CommandContext): Promise<ExecResult> {
    const fs = context.fs;

    // Load isomorphic-git dynamically to keep the core bundle small
    // and avoid node dependencies in non-git contexts.
    let git: any;
    try {
      git = await import("isomorphic-git");
    } catch (e) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "Error: isomorphic-git not installed. Run 'pnpm add isomorphic-git' to enable native git.\n",
      };
    }

    const command = args[0];
    if (!command) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "usage: git <command> [<args>]\n",
      };
    }

    // Map Ag-Bash IFileSystem to isomorphic-git's fs interface
    const gitFs = {
      promises: {
        readFile: (p: string) => fs.readFileBuffer(p),
        writeFile: (p: string, c: any) => fs.writeFile(p, c),
        mkdir: (p: string) => fs.mkdir(p, { recursive: true }),
        rmdir: (p: string) => fs.rm(p, { recursive: true }),
        unlink: (p: string) => fs.rm(p),
        readdir: (p: string) => fs.readdir(p),
        stat: (p: string) => fs.stat(p),
        lstat: (p: string) => fs.lstat(p),
      },
    };

    try {
      const dir = context.cwd || "/";

      switch (command) {
        case "init":
          await git.init({ fs: gitFs, dir });
          return {
            exitCode: 0,
            stdout: `Initialized empty Git repository in ${dir}\n`,
            stderr: "",
          };

        case "add": {
          const filepath = args[1];
          if (!filepath) throw new Error("Nothing specified, nothing added.");
          await git.add({ fs: gitFs, dir, filepath });
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        case "commit": {
          const msgIdx = args.indexOf("-m");
          const message =
            msgIdx !== -1 ? args[msgIdx + 1] : "Commit from Ag-Bash";
          const sha = await git.commit({
            fs: gitFs,
            dir,
            message,
            author: { name: "Ag-Bash Agent", email: "agent@ag-bash.local" },
          });
          return {
            exitCode: 0,
            stdout: `[main ${sha.slice(0, 7)}] ${message}\n`,
            stderr: "",
          };
        }

        case "log": {
          const commits = await git.log({ fs: gitFs, dir });
          const log = commits
            .map(
              (c: any) =>
                `commit ${c.oid}\nAuthor: ${c.commit.author.name}\nDate: ${new Date(c.commit.author.timestamp * 1000).toLocaleString()}\n\n    ${c.commit.message}\n`,
            )
            .join("\n");
          return { exitCode: 0, stdout: log, stderr: "" };
        }

        default:
          return {
            exitCode: 1,
            stdout: "",
            stderr: `git: '${command}' is not yet implemented in Ag-Bash native git.\n`,
          };
      }
    } catch (err: any) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `fatal: ${err.message}\n`,
      };
    }
  },
};
