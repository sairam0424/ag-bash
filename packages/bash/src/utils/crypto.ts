import crypto from "node:crypto";
import type { IFileSystem } from "../fs/interface.js";

/**
 * Calculates the SHA-256 hash of a file's content.
 */
export async function hashFile(fs: IFileSystem, path: string): Promise<string> {
  const content = await fs.readFileBuffer(path);
  const hash = crypto.createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

/**
 * Calculates the SHA-256 hash of a string.
 */
export function hashString(content: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}
