import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";
import { obs, OBSERVATION_CODES } from "./interpreter/helpers/result.js";
import type { Observation } from "./types.js";

/**
 * A3: typed Observation[] is the primary self-correction channel, emitted AT
 * THE FAILURE SOURCE (command resolution, fs read failures) rather than
 * regex-scraped from English stderr by AgTrace after the fact.
 */
describe("observations at the source", () => {
  const find = (
    obsList: Observation[] | undefined,
    type: Observation["type"],
  ): Observation | undefined => obsList?.find((o) => o.type === type);

  it("emits file_not_found with path + machine code from the source (cat)", async () => {
    const bash = new Bash({ parser: { engine: "legacy" } });
    const result = await bash.exec("cat /nonexistent");

    expect(result.exitCode).not.toBe(0);
    const o = find(result.observations, "file_not_found");
    expect(o).toBeDefined();
    // path is captured (as the user referenced it)
    expect(o?.path).toBe("/nonexistent");
    // stable machine code, not English prose
    expect(o?.code).toBe(OBSERVATION_CODES.FILE_NOT_FOUND);
    expect(o?.code).toBe("ENOENT");
    // high confidence — the source KNEW the cause
    expect(o?.confidence).toBe(1);
    // attributed to the command that failed
    expect(o?.command).toBe("cat");
  });

  it("does NOT double-emit file_not_found (source wins, AgTrace gates)", async () => {
    const bash = new Bash({ parser: { engine: "legacy" } });
    const result = await bash.exec("cat /nonexistent");

    const fileNotFound = (result.observations ?? []).filter(
      (o) => o.type === "file_not_found",
    );
    expect(fileNotFound).toHaveLength(1);
    // the surviving one is the high-confidence source observation
    expect(fileNotFound[0]?.confidence).toBe(1);
  });

  it("emits command_not_found with suggestions + machine code from the source", async () => {
    const bash = new Bash({ parser: { engine: "legacy" } });
    const result = await bash.exec("nonexistentcmd");

    expect(result.exitCode).toBe(127);
    const o = find(result.observations, "command_not_found");
    expect(o).toBeDefined();
    expect(o?.command).toBe("nonexistentcmd");
    expect(o?.code).toBe(OBSERVATION_CODES.COMMAND_NOT_FOUND);
    expect(o?.code).toBe("CMD_NOT_FOUND");
    expect(o?.confidence).toBe(1);
  });

  it("suggests a close command for a typo (command_not_found source)", async () => {
    const bash = new Bash({ parser: { engine: "legacy" } });
    // 'ecko' is a single edit away from the registered 'echo'
    const result = await bash.exec("ecko hi");

    expect(result.exitCode).toBe(127);
    const o = find(result.observations, "command_not_found");
    expect(o).toBeDefined();
    expect(o?.suggestions).toContain("echo");
    expect(o?.confidence).toBe(1);
  });

  it("only one command_not_found observation (no AgTrace duplicate)", async () => {
    const bash = new Bash({ parser: { engine: "legacy" } });
    const result = await bash.exec("nonexistentcmd");

    const cmdNotFound = (result.observations ?? []).filter(
      (o) => o.type === "command_not_found",
    );
    expect(cmdNotFound).toHaveLength(1);
  });

  describe("obs factory helpers", () => {
    it("commandNotFound returns a well-formed, frozen observation", () => {
      const o = obs.commandNotFound("gti", ["git"]);
      expect(o.type).toBe("command_not_found");
      expect(o.command).toBe("gti");
      expect(o.suggestions).toEqual(["git"]);
      expect(o.code).toBe("CMD_NOT_FOUND");
      expect(o.confidence).toBe(1);
      expect(Object.isFrozen(o)).toBe(true);
    });

    it("commandNotFound omits empty suggestions", () => {
      const o = obs.commandNotFound("gti");
      expect(o.suggestions).toBeUndefined();
    });

    it("fileNotFound carries path + command + ENOENT code", () => {
      const o = obs.fileNotFound("/x/y.txt", "cat");
      expect(o.type).toBe("file_not_found");
      expect(o.path).toBe("/x/y.txt");
      expect(o.command).toBe("cat");
      expect(o.code).toBe("ENOENT");
      expect(o.confidence).toBe(1);
    });

    it("directoryNotFound maps to ENOENT_DIR", () => {
      const o = obs.directoryNotFound("/x");
      expect(o.type).toBe("directory_not_found");
      expect(o.code).toBe("ENOENT_DIR");
    });

    it("isADirectory maps to EISDIR (file_not_found category)", () => {
      const o = obs.isADirectory("/etc");
      expect(o.type).toBe("file_not_found");
      expect(o.code).toBe("EISDIR");
    });

    it("notADirectory maps to ENOTDIR (directory_not_found category)", () => {
      const o = obs.notADirectory("/etc/passwd/x");
      expect(o.type).toBe("directory_not_found");
      expect(o.code).toBe("ENOTDIR");
    });

    it("permissionDenied maps to EACCES", () => {
      const o = obs.permissionDenied("/root/secret", "cat");
      expect(o.type).toBe("permission_denied");
      expect(o.code).toBe("EACCES");
      expect(o.path).toBe("/root/secret");
      expect(o.command).toBe("cat");
      expect(o.confidence).toBe(1);
    });
  });

  it("classifies reading a directory as EISDIR at the source", async () => {
    const bash = new Bash({ parser: { engine: "legacy" } });
    // create a directory and try to cat it
    await bash.exec("mkdir -p /tmp/adir");
    const result = await bash.exec("cat /tmp/adir");

    expect(result.exitCode).not.toBe(0);
    const o = find(result.observations, "file_not_found");
    // EISDIR is categorized under file_not_found type with a precise code
    expect(o?.code).toBe("EISDIR");
    expect(o?.path).toBe("/tmp/adir");
  });
});
