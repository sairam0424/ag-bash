import { createChecksumCommand } from "./checksum.js";
export const md5sumCommand = createChecksumCommand("md5sum", "md5", "compute MD5 message digest");
export const flagsForFuzzing = {
    name: "md5sum",
    flags: [{ flag: "-c", type: "boolean" }],
    needsFiles: true,
};
