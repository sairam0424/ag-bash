import { beforeEach, describe, expect, it } from "vitest";
import { BashToolbox } from "./agentic/BashToolbox.js";
import { Bash } from "./Bash.js";
import { InMemoryFs } from "./fs/in-memory-fs/index.js";

describe("Workspace Indexing (Phase 8)", () => {
  let bash: Bash;
  let tools: any;

  beforeEach(async () => {
    bash = new Bash({
      parserEngine: "legacy",
      fs: new InMemoryFs(),
    });
    await bash.fs.mkdir("/src", { recursive: true });
    await bash.writeFileDirect(
      "/src/math.sh",
      "add() { echo $(($1 + $2)); }\nPI=3.14",
    );
    await bash.writeFileDirect(
      "/src/utils.sh",
      'log() { echo "$1"; }\nVERSION=1.0',
    );
    await bash.writeFileDirect("/README.md", "Not a bash file");
    const toolbox = new BashToolbox();
    tools = toolbox.getAgenticTools(bash);
  });

  it("should index the entire workspace", async () => {
    const res = await tools.index_workspace.execute({});
    expect(res).toBe("Successfully indexed the workspace.");

    // index.json should exist
    expect(await bash.fs.exists("/.ag-bash/index.json")).toBe(true);

    const search1 = await tools.find_symbols.execute({ query: "add" });
    expect(search1.length).toBe(1);
    expect(search1[0].name).toBe("add");
    expect(search1[0].path).toBe("/src/math.sh");

    const search2 = await tools.find_symbols.execute({ query: "PI" });
    expect(search2[0].name).toBe("PI");
    expect(search2[0].type).toBe("Variable");

    const search3 = await tools.find_symbols.execute({ query: "log" });
    expect(search3[0].path).toBe("/src/utils.sh");
  });

  it("should handle fuzzy search", async () => {
    await tools.index_workspace.execute({});
    const res = await tools.find_symbols.execute({ query: "ad" });
    expect(res.some((s: any) => s.name === "add")).toBe(true);
  });
});
