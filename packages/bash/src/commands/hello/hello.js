/**
 * hello command - A friendly greeting from AG Bash
 */
export const helloCommand = {
    name: "hello",
    async execute(args, _ctx) {
        const name = args.length > 0 ? args.join(" ") : "Agent";
        const output = `Hello, ${name}! Welcome to AG Bash.\nThis is your custom shell environment for agentic tasks.\n`;
        return {
            stdout: output,
            stderr: "",
            exitCode: 0,
        };
    },
};
