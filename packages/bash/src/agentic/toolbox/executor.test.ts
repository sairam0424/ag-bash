/**
 * Regression tests for artifact-spill path collisions (U46).
 *
 * When a tool result exceeds `maxResultSizeChars`, executeTool() spills it to a
 * file under a single shared ARTIFACT_DIR and hands the caller back the path.
 * The id in that filename used to be `Math.random().toString(36).substring(2, 10)`
 * with no existence check before an overwriting write, so two spills could land
 * on the same path. That is not merely lost data: sibling sub-agents are
 * separate `Bash` instances in the SAME process (AgentManager.spawn) whose CoW
 * overlays are merged back into one parent filesystem, so agent A can be handed
 * a path that agent B's spill later occupies — A then reads B's tool output
 * across a trust boundary.
 *
 * These tests neutralise the entropy the id can draw from, which turns the
 * probabilistic collision into a deterministic one. A spill implementation that
 * relies on randomness alone fails them; one that is unique by construction
 * (monotonic per-realm sequence) passes. See `freezeEntropy` for why the
 * `Math.random` half of that is best effort and why the tests stay meaningful
 * without it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Bash } from "../../Bash.js";
import { createTestBash } from "../../testing/createTestBash.js";
import { buildTool, type ToolboxTool } from "../Tool.js";
import { executeTool } from "./executor.js";

/** Small enough that every tool result below is guaranteed to spill. */
const SPILL_LIMIT = 64;

/** Name reused by every spill, so all spills share one filename prefix. */
const SPILL_TOOL = "spill";

interface SpillArgs {
  marker: string;
}

type SpillRegistry = Map<string, ToolboxTool<SpillArgs, string>>;

interface ArtifactResult {
  type: "artifact";
  message: string;
  path: string;
  preview: string;
}

function assertArtifact(value: unknown): ArtifactResult {
  expect(value).toMatchObject({ type: "artifact" });
  const candidate = value as ArtifactResult;
  // Shape contract callers depend on — must survive the fix.
  expect(typeof candidate.message).toBe("string");
  expect(typeof candidate.path).toBe("string");
  expect(typeof candidate.preview).toBe("string");
  expect(candidate.path.length).toBeGreaterThan(0);
  return candidate;
}

/**
 * A registry holding one tool whose result always exceeds SPILL_LIMIT and is
 * tagged with the caller's marker, so each spill's content is identifiable.
 */
function buildSpillRegistry(): SpillRegistry {
  const tool = buildTool<SpillArgs, string>({
    name: SPILL_TOOL,
    description: "Returns an oversized result tagged with the caller's marker.",
    parameters: z.object({ marker: z.string() }),
    maxResultSizeChars: SPILL_LIMIT,
    isReadOnly: true,
    execute: async (_bash: Bash, args: SpillArgs) =>
      `${args.marker}${"x".repeat(SPILL_LIMIT * 4)}`,
  });
  return new Map([[SPILL_TOOL, tool]]);
}

async function spill(
  bash: Bash,
  tools: SpillRegistry,
  marker: string,
): Promise<ArtifactResult> {
  return assertArtifact(await executeTool(bash, SPILL_TOOL, { marker }, tools));
}

/**
 * Neutralises the entropy sources a spill id can draw from, so any remaining
 * uniqueness has to come from structure rather than luck.
 *
 * `crypto` is the source the implementation prefers and is always stubbable —
 * `security/browser-hardening.ts` deliberately does not freeze it.
 * `Math.random` is only the no-CSPRNG fallback and is best effort: that same
 * hardening pass calls `Object.freeze(Math)` process-wide and irreversibly
 * ("Test-only: reset ... does NOT un-freeze anything"), so in a Vitest worker
 * that has already run a hardening test, `Math.random` can no longer be
 * redefined. Returns which sources were neutralised so the caller can prove the
 * freeze took effect instead of passing vacuously.
 */
function freezeEntropy(): { crypto: boolean; math: boolean } {
  let cryptoFrozen = false;
  let mathFrozen = false;

  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues === "function") {
    vi.spyOn(webCrypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array) {
          new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(
            0,
          );
        }
        return array;
      },
    );
    if (typeof webCrypto.randomUUID === "function") {
      vi.spyOn(webCrypto, "randomUUID").mockReturnValue(
        "00000000-0000-4000-8000-000000000000",
      );
    }
    cryptoFrozen = true;
  }

  try {
    vi.spyOn(Math, "random").mockReturnValue(0.4242424242424242);
    mathFrozen = true;
  } catch {
    // Math was frozen by a hardening test earlier in this worker. Ignored: the
    // implementation only reaches Math.random when crypto is unavailable, and
    // the assertion below requires at least one source to be neutralised.
  }

  return { crypto: cryptoFrozen, math: mathFrozen };
}

/**
 * Neutralises entropy and proves it took, so a passing assertion below can only
 * mean the spill path is unique by construction.
 */
function freezeEntropyOrFail(): void {
  const frozen = freezeEntropy();
  expect(
    frozen.crypto || frozen.math,
    "no entropy source could be neutralised, so this test would be vacuous",
  ).toBe(true);
  if (frozen.crypto) {
    expect(
      Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4))),
    ).toEqual([0, 0, 0, 0]);
  }
  if (frozen.math) {
    expect(Math.random()).toBe(Math.random());
  }
}

describe("executeTool artifact spill paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not let a later spill clobber an earlier agent's artifact", async () => {
    freezeEntropyOrFail();
    const bash = createTestBash();
    const tools = buildSpillRegistry();

    const alpha = await spill(bash, tools, "ALPHA");
    const beta = await spill(bash, tools, "BETA");

    // The confidentiality property: the path handed to the first caller must
    // still hold the FIRST caller's output, not the second caller's.
    await expect(bash.fs.readFile(alpha.path, "utf-8")).resolves.toContain(
      "ALPHA",
    );
    await expect(bash.fs.readFile(beta.path, "utf-8")).resolves.toContain(
      "BETA",
    );
    expect(alpha.path).not.toBe(beta.path);
    await expect(bash.fs.readFile(alpha.path, "utf-8")).resolves.not.toContain(
      "BETA",
    );
  });

  it("gives every concurrent spill its own path", async () => {
    freezeEntropyOrFail();
    const bash = createTestBash();
    const tools = buildSpillRegistry();
    const markers = ["C0", "C1", "C2", "C3", "C4", "C5"];

    // Interleaved at await points inside executeTool, exactly like sibling
    // sub-agents spilling through one shared ARTIFACT_DIR.
    const results = await Promise.all(
      markers.map((marker) => spill(bash, tools, marker)),
    );

    const paths = results.map((result) => result.path);
    expect(new Set(paths).size).toBe(markers.length);
    for (const [index, result] of results.entries()) {
      await expect(bash.fs.readFile(result.path, "utf-8")).resolves.toContain(
        markers[index],
      );
    }
  });

  it("never writes a spill onto a path that already exists", async () => {
    freezeEntropyOrFail();
    const bash = createTestBash();
    const tools = buildSpillRegistry();

    const clobbered: string[] = [];
    const write = bash.writeFileDirect.bind(bash);
    vi.spyOn(bash, "writeFileDirect").mockImplementation(
      async (path: string, content: string) => {
        if (await bash.fs.exists(path)) {
          clobbered.push(path);
        }
        return write(path, content);
      },
    );

    for (const marker of ["P0", "P1", "P2", "P3"]) {
      await spill(bash, tools, marker);
    }

    expect(clobbered).toEqual([]);
  });
});
