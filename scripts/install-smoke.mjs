import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

// Clean-room published-artifact smoke test. Packs all three packages with
// `pnpm pack`, installs the tarballs into a throwaway project OUTSIDE the
// monorepo with plain `npm install` (reproducing what a real consumer gets —
// flat-hoisted node_modules, no workspace symlinks), then exercises the public
// surface: every @ag-bash/bash export subpath, both bins, the MCP stdio
// handshake, and each WASM runtime's documented contract. This is the ONLY gate
// that catches packaging defects the in-repo workspace can't (it always
// resolves) — e.g. the v6.0.0 `workspace:*` leak and the v6.0.2 missing-WASM.
// Each failure prints a clear, actionable message.
//
// Usage: node scripts/install-smoke.mjs   (run AFTER `pnpm build`)

const ROOT = resolve(import.meta.dirname, "..");
/**
 * Typed signal python3 emits when the CPython Emscripten runtime is absent from
 * the build (see `RUNTIME_NOT_BUNDLED` in
 * packages/bash/src/commands/python3/python3.ts). Asserting on this code — not
 * on English prose — is what makes the python3 contract below machine-checkable.
 */
const RUNTIME_NOT_BUNDLED = "RUNTIME_NOT_BUNDLED";
const BASH_SUBPATHS = [
  "",
  "/browser",
  "/browser-core",
  "/slim",
  "/advanced",
  "/testing",
  "/ai",
  "/agent-runtime",
];

const failures = [];
function fail(msg) {
  failures.push(msg);
  console.error(`  ✗ ${msg}`);
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

const stage = mkdtempSync(join(tmpdir(), "agbash-smoke-"));
const consumer = join(stage, "consumer");

try {
  // 1. Pack all three packages into the staging dir.
  console.log("[1/6] pnpm pack (3 packages)…");
  const tarballs = [];
  for (const dir of [
    "packages/bash",
    "packages/mcp-server",
    "packages/agent-bridge",
  ]) {
    const out = run("pnpm", ["pack", "--pack-destination", stage], {
      cwd: resolve(ROOT, dir),
    });
    const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
    const tgz = line.startsWith("/") ? line : join(stage, line);
    tarballs.push(tgz);
    ok(`packed ${dir}`);
  }

  // 2. Clean-room npm install (no workspace, flat node_modules like a consumer).
  console.log("[2/6] npm install tarballs into clean consumer…");
  run("mkdir", ["-p", consumer]);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "smoke-consumer",
        version: "1.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  run("npm", ["install", "--no-audit", "--no-fund", ...tarballs], {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  ok("installed @ag-bash/bash, @ag-bash/mcp-server, @ag-bash/agent-bridge");

  // 3. Resolve every @ag-bash/bash export subpath.
  console.log("[3/6] resolve all 8 @ag-bash/bash export subpaths…");
  const probe = BASH_SUBPATHS.map(
    (sp) =>
      `import('@ag-bash/bash${sp}').then(()=>console.log('OK ${sp || "."}'))` +
      `.catch(e=>{console.error('FAIL ${sp || "."} '+(e.code||e.message));process.exitCode=1});`,
  ).join("\n");
  const subRes = spawnSync("node", ["--input-type=module", "-e", probe], {
    cwd: consumer,
    encoding: "utf8",
  });
  process.stdout.write((subRes.stdout || "").replace(/^/gm, "    "));
  if (subRes.status !== 0)
    fail("one or more export subpaths failed to resolve");
  else ok("all 8 subpaths resolve");

  // 4. Run the two bins. ag-bash -c must echo; ag-shell --version must start.
  console.log("[4/6] run bins (ag-bash, ag-bash-mcp)…");
  const agBash = spawnSync(
    "node",
    ["node_modules/@ag-bash/bash/dist/bin/ag-bash.js", "-c", "echo SMOKE_OK"],
    { cwd: consumer, encoding: "utf8" },
  );
  if (agBash.status === 0 && (agBash.stdout || "").includes("SMOKE_OK"))
    ok("ag-bash -c 'echo' works");
  else
    fail(
      `ag-bash bin failed (exit ${agBash.status}): ${agBash.stderr?.slice(0, 300)}`,
    );

  // 5. MCP stdio initialize handshake.
  console.log("[5/6] ag-bash-mcp stdio initialize handshake…");
  // `capabilities` is the empty-capability set MCP requires in `initialize`.
  // Object.create(null) rather than {} to satisfy the repo's no-bare-record rule
  // (scripts/check-banned-patterns.js), and rather than nullPrototype() from
  // packages/bash/src/fs/safe-object.ts because this script is plain ESM run by
  // bare `node` before/independently of any build — it cannot import package
  // source. JSON.stringify serializes a null-prototype object to `{}`, so the
  // bytes on the wire are unchanged.
  const initMsg = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: Object.create(null),
      clientInfo: { name: "smoke", version: "1.0.0" },
    },
  });
  const mcp = spawnSync(
    "node",
    ["node_modules/@ag-bash/mcp-server/dist/index.js"],
    { cwd: consumer, input: `${initMsg}\n`, encoding: "utf8", timeout: 30000 },
  );
  const mcpOut = `${mcp.stdout || ""}${mcp.stderr || ""}`;
  if (mcpOut.includes('"capabilities"') && mcpOut.includes('"result"'))
    ok("MCP initialize handshake returns capabilities");
  else
    fail(
      `ag-bash-mcp handshake failed (exit ${mcp.status}): ${mcpOut.slice(0, 400)}`,
    );

  // agent-bridge has no bin (verified) — just confirm it imports.
  const ab = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      "import('@ag-bash/agent-bridge').then(()=>{}).catch(e=>{console.error(e.message);process.exitCode=1})",
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  if (ab.status === 0) ok("@ag-bash/agent-bridge imports");
  else fail(`agent-bridge import failed: ${ab.stderr?.slice(0, 200)}`);

  // 6. Exercise each WASM runtime's DOCUMENTED contract from the installed
  //    tarball. Resolving a subpath and echoing a string (steps 3-4) proves
  //    nothing about the runtimes, which is how a tarball with a dead python3
  //    stayed invisible. Each runtime is asserted against what it actually
  //    promises a consumer, so "green" means the promise held:
  //      - js-exec  (QuickJS, npm dep `quickjs-emscripten`) → must COMPUTE.
  //      - sqlite3  (sql.js, npm dep `sql.js`)              → must COMPUTE.
  //      - python3  (CPython Emscripten, vendored, NOT in `files`) → must refuse
  //        with a TYPED signal. See the comment on that assertion.
  console.log("[6/6] runtime contracts (js-exec, sqlite3, python3)…");

  const runBin = (flags, script) =>
    spawnSync(
      "node",
      [
        "node_modules/@ag-bash/bash/dist/bin/ag-bash.js",
        ...flags,
        "-c",
        script,
      ],
      { cwd: consumer, encoding: "utf8", timeout: 120000 },
    );

  const js = runBin(["--javascript"], 'js-exec -c "console.log(6*7)"');
  if (js.status === 0 && (js.stdout || "").includes("42"))
    ok("js-exec (QuickJS) computes 6*7 → 42");
  else
    fail(
      `js-exec runtime is broken in the tarball (exit ${js.status}): ` +
        `${(js.stdout || "").slice(0, 200)}${(js.stderr || "").slice(0, 300)}`,
    );

  const sqlite = runBin([], 'sqlite3 :memory: "select 6*7;"');
  if (sqlite.status === 0 && (sqlite.stdout || "").includes("42"))
    ok("sqlite3 (sql.js) computes select 6*7 → 42");
  else
    fail(
      `sqlite3 runtime is broken in the tarball (exit ${sqlite.status}): ` +
        `${(sqlite.stdout || "").slice(0, 200)}${(sqlite.stderr || "").slice(0, 300)}`,
    );

  // python3's contract TODAY is an honest refusal, not a working interpreter:
  // `files` ships dist/ + scripts/ only, so vendor/cpython-emscripten/ never
  // reaches a consumer. Asserting `print(42)` here would install a permanently
  // RED required gate, so instead we pin the refusal to the typed
  // RUNTIME_NOT_BUNDLED signal — which also guards against the old failure mode
  // where a missing binary surfaced as a `[Defense-in-depth]` security block and
  // sent debuggers the wrong way.
  //
  // ►► BACKLOG ITEM U5 ("Tarball ships no CPython") FLIPS THIS ONE ASSERTION.
  //    When U5 lands, delete the RUNTIME_NOT_BUNDLED branch and assert
  //    `py.status === 0 && py.stdout.includes("42")`, exactly like js-exec
  //    above. Nothing else in this file changes. Until then the tripwire below
  //    fails loudly if python3 unexpectedly starts working, so a shipped
  //    CPython can never sit behind a stale assertion.
  const py = runBin(["--python"], 'python3 -c "print(6*7)"');
  const pyOut = `${py.stdout || ""}${py.stderr || ""}`;
  if (py.status === 0 && (py.stdout || "").includes("42"))
    fail(
      "python3 now WORKS from the tarball — the CPython runtime shipped. " +
        "That is the U5 goal, but this assertion still checks for the refusal: " +
        "flip it to assert '42' (see the comment above this check).",
    );
  else if (pyOut.includes(RUNTIME_NOT_BUNDLED))
    ok(
      `python3 refuses with the typed ${RUNTIME_NOT_BUNDLED} signal ` +
        "(expected until U5 ships CPython in the tarball)",
    );
  else
    fail(
      `python3 failed WITHOUT the typed ${RUNTIME_NOT_BUNDLED} signal ` +
        `(exit ${py.status}). A missing runtime must say so in machine-readable ` +
        `terms, not as a generic or security-flavored error: ${pyOut.slice(0, 400)}`,
    );
} finally {
  rmSync(stage, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n✗ install-smoke FAILED with ${failures.length} problem(s).`);
  console.error(
    "The PUBLISHED artifact is broken even though in-repo tests pass — the " +
      "workspace always resolves, a clean consumer install does not.",
  );
  process.exit(1);
}
console.log(
  "\n✓ install-smoke passed: published artifacts install and run clean.",
);
