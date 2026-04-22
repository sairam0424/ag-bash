import { describe, it, expect, beforeEach } from "vitest";
import { Bash } from "./Bash.js";
import { BashToolbox } from "./agentic/BashToolbox.js";
import { InMemoryFs } from "./fs/in-memory-fs/index.js";

describe("Incremental Indexing (Phase 8)", () => {
  let bash: Bash;
  let tools: any;

  beforeEach(async () => {
    bash = new Bash({
      parserEngine: 'legacy',
      fs: new InMemoryFs(),
    });
    const toolbox = new BashToolbox();
    tools = toolbox.getAgenticTools(bash);
  });

  it("should index file automatically on write_file", async () => {
    await tools.write_file.execute({ path: "/test.sh", content: "hello() { echo hi; }" });
    
    // Check if index.json was created
    expect(await bash.fs.exists("/.ag-bash/index.json")).toBe(true);

    const search = await tools.find_symbols.execute({ query: "hello" });
    expect(search.length).toBe(1);
    expect(search[0].name).toBe("hello");
    expect(search[0].path).toBe("/test.sh");
  });

  it("should update index on edit_file", async () => {
    await tools.write_file.execute({ path: "/test.sh", content: "old_fn() { :; }" });
    
    // Replace old_fn with new_fn
    await tools.edit_file.execute({
      path: "/test.sh",
      target: "old_fn",
      replacement: "new_fn",
    });

    const searchOld = await tools.find_symbols.execute({ query: "old_fn" });
    expect(searchOld.length).toBe(0);

    const searchNew = await tools.find_symbols.execute({ query: "new_fn" });
    expect(searchNew.length).toBe(1);
    expect(searchNew[0].name).toBe("new_fn");
  });
});
