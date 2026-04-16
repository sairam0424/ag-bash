import { getAllCommandFuzzInfo } from "./fuzz-flags.js";
const flagMap = new Map();
for (const info of getAllCommandFuzzInfo()) {
    flagMap.set(info.name, new Set(info.flags.map((f) => f.flag)));
}
export function emitFlagCoverage(coverage, cmdName, args) {
    const knownFlags = flagMap.get(cmdName);
    if (!knownFlags || knownFlags.size === 0)
        return;
    for (const arg of args) {
        if (knownFlags.has(arg)) {
            coverage.hit(`cmd:flag:${cmdName}:${arg}`);
        }
    }
}
