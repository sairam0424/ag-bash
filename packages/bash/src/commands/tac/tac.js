/**
 * tac - concatenate and print files in reverse
 *
 * Usage: tac [OPTION]... [FILE]...
 *
 * Writes each FILE to standard output, last line first.
 */
async function tacExecute(args, ctx) {
    if (args.length > 0 && args[0] !== "-") {
        // Try to read from file
        const filePath = ctx.fs.resolvePath(ctx.cwd, args[0]);
        try {
            const content = await ctx.fs.readFile(filePath);
            const lines = content.split("\n");
            if (lines[lines.length - 1] === "") {
                lines.pop();
            }
            const reversed = lines.reverse();
            return {
                stdout: reversed.length > 0 ? `${reversed.join("\n")}\n` : "",
                stderr: "",
                exitCode: 0,
            };
        }
        catch {
            return {
                stdout: "",
                stderr: `tac: ${args[0]}: No such file or directory\n`,
                exitCode: 1,
            };
        }
    }
    // Read from stdin
    const lines = ctx.stdin.split("\n");
    if (lines[lines.length - 1] === "") {
        lines.pop();
    }
    const reversed = lines.reverse();
    return {
        stdout: reversed.length > 0 ? `${reversed.join("\n")}\n` : "",
        stderr: "",
        exitCode: 0,
    };
}
export const tac = {
    name: "tac",
    execute: tacExecute,
};
export const flagsForFuzzing = {
    name: "tac",
    flags: [],
    stdinType: "text",
    needsFiles: true,
};
