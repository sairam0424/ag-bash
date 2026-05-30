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
import { bench, describe } from "vitest";
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

describe("parser", () => {
  bench("parse representative script", () => {
    parse(REPRESENTATIVE_SCRIPT);
  });

  bench("parse small one-liner", () => {
    parse(SMALL_SCRIPT);
  });
});
