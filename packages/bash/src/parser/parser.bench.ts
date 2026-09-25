/**
 * Performance benchmarks for the legacy recursive-descent parser.
 *
 * Covers `parse()` (the synchronous, WASM-free hot path) over a
 * representative bash script that exercises loops, conditionals,
 * assignments, expansions, and a multi-stage pipeline.
 *
 * Run: pnpm bench (all benches) or
 *      pnpm exec vitest bench --run src/parser/parser.bench.ts
 *
 * These files are NOT part of `test:run` — vitest's default test glob
 * matches only `*.{test,spec}.ts`, so `*.bench.ts` runs only under
 * `vitest bench`.
 */
import { describe, it } from "vitest";
import { parse } from "./parser.js";

const REPRESENTATIVE_SCRIPT = `#!/bin/bash
set -euo pipefail
TARGET_DIR="\${1:-/var/log}"
count=0
for f in "$TARGET_DIR"/*.log; do
  if [ -f "$f" ]; then
    lines=$(wc -l < "$f")
    echo "processing $f ($lines lines)"
    count=$((count + 1))
  fi
done
while read -r line; do
  case "$line" in
    ERROR*) echo "err: $line" ;;
    WARN*)  echo "warn: $line" ;;
    *)      printf '%s\\n' "$line" ;;
  esac
done < input.txt
cat data.txt | grep -v '^#' | sort -u | head -n 20 > out.txt
echo "done: $count files processed"
`;

const SMALL_SCRIPT = `echo hello | grep h | wc -c`;

// Vitest 5 moved `bench` from a top-level describe-block function to a
// TestContext fixture: each benchmark is its own `it(...)` receiving
// `{ bench }`, which is itself the registration factory (`bench(name, fn)`)
// - calling `.run()` on the returned registration is what actually executes
// and reports it. Keeping one `it` per former `bench` call preserves the
// same benchmark names for the historical bench-results.json entries.
describe("parser", () => {
  it("parse representative script", async ({ bench }) => {
    await bench("parse representative script", () => {
      parse(REPRESENTATIVE_SCRIPT);
    }).run();
  });

  it("parse small one-liner", async ({ bench }) => {
    await bench("parse small one-liner", () => {
      parse(SMALL_SCRIPT);
    }).run();
  });
});
