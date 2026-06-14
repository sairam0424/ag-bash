import { beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import { Orchestrator } from "./Orchestrator.js";

describe("Orchestrator", () => {
  let parent: Bash;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    parent = new Bash({ fs: new InMemoryFs(), agentic: { enabled: true } });
    orchestrator = new Orchestrator();
  });

  describe("spawn with toolSubset (immutable allowlist)", () => {
    it("does not crash when a toolSubset is provided", async () => {
      // Regression: the old implementation called
      // `(agent.toolbox as any).unregisterTool(...)` which masked a missing
      // API and crashed any toolSubset-filtered spawn at runtime.
      await expect(
        orchestrator.spawn(parent, {
          name: "filtered",
          toolSubset: ["read_file", "write_file"],
        }),
      ).resolves.toBeInstanceOf(Bash);
    });

    it("constrains the child toolbox to exactly the allowed tools", async () => {
      const allowed = ["read_file", "list_dir"];
      const child = await orchestrator.spawn(parent, {
        name: "narrow",
        toolSubset: allowed,
      });

      const childToolNames = child.toolbox
        .getTools()
        .map((t) => t.name)
        .sort();
      expect(childToolNames).toEqual([...allowed].sort());
    });

    it("removes tools that are not in the allowlist", async () => {
      const child = await orchestrator.spawn(parent, {
        name: "no-write",
        toolSubset: ["read_file"],
      });

      expect(child.toolbox.getTool("read_file")).toBeDefined();
      // write_file exists on a default toolbox but must be stripped here.
      expect(child.toolbox.getTool("write_file")).toBeUndefined();
    });

    it("ignores allowlist entries that do not correspond to real tools", async () => {
      const child = await orchestrator.spawn(parent, {
        name: "ghost",
        toolSubset: ["read_file", "this_tool_does_not_exist"],
      });

      const childToolNames = child.toolbox.getTools().map((t) => t.name);
      expect(childToolNames).toEqual(["read_file"]);
    });

    it("does not mutate the parent toolbox while filtering the child", async () => {
      const parentToolCountBefore = parent.toolbox.getTools().length;

      await orchestrator.spawn(parent, {
        name: "child",
        toolSubset: ["read_file"],
      });

      // Filtering the child must never strip tools from the parent.
      expect(parent.toolbox.getTools().length).toBe(parentToolCountBefore);
      expect(parent.toolbox.getTool("write_file")).toBeDefined();
    });
  });

  describe("spawn without toolSubset", () => {
    it("keeps the full default toolbox when no toolSubset is given", async () => {
      const full = await orchestrator.spawn(parent, { name: "full" });
      // A default agent should retain its standard tools (e.g. write_file).
      expect(full.toolbox.getTool("write_file")).toBeDefined();
      expect(full.toolbox.getTools().length).toBeGreaterThan(1);
    });
  });

  describe("agent registry", () => {
    it("tracks spawned agents by name", async () => {
      await orchestrator.spawn(parent, { name: "a" });
      await orchestrator.spawn(parent, { name: "b" });

      expect(orchestrator.listAgents().sort()).toEqual(["a", "b"]);
      expect(orchestrator.getAgent("a")).toBeInstanceOf(Bash);
      expect(orchestrator.getAgent("missing")).toBeUndefined();
    });

    it("increments nesting depth for spawned children", async () => {
      const child = await orchestrator.spawn(parent, { name: "deep" });
      expect(child.nestingDepth).toBe(parent.nestingDepth + 1);
    });
  });
});
