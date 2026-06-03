import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

// Clean-room published-artifact smoke test. Packs all three packages with
// `pnpm pack`, installs the tarballs into a throwaway project OUTSIDE the
// monorepo with plain `npm install` (reproducing what a real consumer gets —
// flat-hoisted node_modules, no workspace symlinks), then exercises the public
// surface: every @ag-bash/bash export subpath, both bins, and the MCP stdio
// handshake. This is the ONLY gate that catches packaging defects the in-repo
// workspace can't (it always resolves) — e.g. the v6.0.0 `workspace:*` leak and
// the v6.0.2 missing-WASM. Each failure prints a clear, actionable message.
//
// Usage: node scripts/install-smoke.mjs   (run AFTER `pnpm build`)

const ROOT = resolve(import.meta.dirname, "..");
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
  console.log("[1/5] pnpm pack (3 packages)…");
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
  console.log("[2/5] npm install tarballs into clean consumer…");
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
  console.log("[3/5] resolve all 8 @ag-bash/bash export subpaths…");
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
  console.log("[4/5] run bins (ag-bash, ag-bash-mcp)…");
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
  console.log("[5/5] ag-bash-mcp stdio initialize handshake…");
  const initMsg = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
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
