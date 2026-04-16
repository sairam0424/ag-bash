export const trueCommand = {
    name: "true",
    async execute() {
        return { stdout: "", stderr: "", exitCode: 0 };
    },
};
export const falseCommand = {
    name: "false",
    async execute() {
        return { stdout: "", stderr: "", exitCode: 1 };
    },
};
export const flagsForFuzzing = {
    name: "true",
    flags: [],
};
export const falseFlagsForFuzzing = {
    name: "false",
    flags: [],
};
