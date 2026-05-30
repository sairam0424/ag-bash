/**
 * End-to-end performance benchmark for Bash.exec in pipeline mode
 * (the default v6.0.0 execution engine).
 *
 * Each iteration constructs a fresh Bash instance (cold path: no cache
 * warmth, no persisted state) and runs a small in-memory pipeline so
 * the number reflects construct + normalize + parse + interpret +
 * teardown — the realistic per-call cost agents pay.
 *
 * A second bench reuses a single instance to isolate the steady-state
 * exec cost once the ASTCache and services are warm.
 *
 * No WASM runtimes (python/js-exec) are touched, so there is no worker
 * thread and no hang risk under `vitest bench`.
 *
 * Run: pnpm exec vitest bench --run src/Bash.exec.bench.ts
 */
import { bench, describe } from "vitest";
import { Bash } from "./Bash.js";

const SCRIPT = "cat /app/data.txt | grep foo | wc -l";
const FILES = { "/app/data.txt": "hello world\nfoo bar\nfoo baz\nqux\n" };

// Shared warm instance for the steady-state bench.
const warmBash = new Bash({ cwd: "/app", files: FILES });

describe("Bash.exec (pipeline)", () => {
  bench("cold — new instance + small pipeline", async () => {
    const bash = new Bash({ cwd: "/app", files: FILES });
    await bash.exec(SCRIPT, { execMode: "pipeline" });
  });

  bench("warm — reused instance, ASTCache hot", async () => {
    await warmBash.exec(SCRIPT, { execMode: "pipeline" });
  });

  bench("warm — simple echo", async () => {
    await warmBash.exec("echo hello world", { execMode: "pipeline" });
  });
});
