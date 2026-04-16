import { createChecksumCommand } from "./checksum.js";
export const sha1sumCommand = createChecksumCommand("sha1sum", "sha1", "compute SHA1 message digest");
export const flagsForFuzzing = {
    name: "sha1sum",
    flags: [{ flag: "-c", type: "boolean" }],
    needsFiles: true,
};
