import { createChecksumCommand } from "./checksum.js";
export const sha256sumCommand = createChecksumCommand("sha256sum", "sha256", "compute SHA256 message digest");
export const flagsForFuzzing = {
    name: "sha256sum",
    flags: [{ flag: "-c", type: "boolean" }],
    needsFiles: true,
};
