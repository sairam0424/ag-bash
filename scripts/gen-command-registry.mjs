#!/usr/bin/env node
/**
 * Generates the command inventory in docs/COMMAND_REGISTRY.md.
 *
 * WHY. The doc was hand-maintained with no derivation from the registry, drifted
 * to v5.0.0, and omitted 33 registered commands including `cat` and `echo` — the
 * same failure mode as the builtin count that was hardcoded as 120/100/70 in
 * three places until it was derived from `getCommandNames()`.
 *
 * SOURCE OF TRUTH. `packages/bash/src/commands/definitions/{core,text,agentic,
 * runtimes}.ts`. Those four modules import nothing at runtime (both of their
 * imports are `import type`), so Node's native TypeScript type stripping loads
 * the SOURCE with a bare `node` — no build, no deps, no tsx. That matters: a
 * generator that only runs post-build is a generator that stops getting run.
 * `engines.node` is >= 20.6.0 and CI runs a 20/22/24 matrix, and Node < 22.18
 * has no type stripping, so there is a fallback to `packages/bash/dist/...`.
 *
 * The aggregation below MIRRORS registry.ts's accessors (getCommandNames() =
 * core + text + agentic, plus the three runtime-gated accessors) rather than
 * calling them, because registry.ts imports `./lib.js` at runtime and type
 * stripping does not rewrite a `.js` specifier to `.ts`. The mirror is not
 * trusted on faith: packages/bash/src/commands/registry.doc.test.ts compares the
 * generated doc against the REAL accessors, so a divergence fails that test.
 *
 * WHAT STILL NEEDS A HUMAN. Per-command descriptions and doc categories do not
 * exist in the engine, so they are carried in COMMAND_DOCS below — option (b),
 * "generate everything and keep the prose data next to the generator". Option
 * (a), generating names only and leaving hand-written description tables in the
 * doc, was rejected: it prints every command name twice, once generated and once
 * authored, which is the exact drift vector being removed. Consequence, stated
 * plainly: registering a new command needs ONE hand-written line here, and this
 * script fails loudly until it is written. It never invents a description and
 * never silently drops one.
 *
 *   node scripts/gen-command-registry.mjs           # rewrite the block
 *   node scripts/gen-command-registry.mjs --check   # verify, exit 1 on drift
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DOC_PATH = resolve(REPO_ROOT, "docs/COMMAND_REGISTRY.md");
const DOC_DIR = dirname(DOC_PATH);
const DIST_PROBE = resolve(
  REPO_ROOT,
  "packages/bash/dist/commands/definitions/core.js",
);

const BEGIN_MARKER = "<!-- BEGIN GENERATED: command-inventory -->";
const END_MARKER = "<!-- END GENERATED: command-inventory -->";

/** Mirrors registry.ts's getPythonCommandNames() filter. */
const PYTHON_NAMES = new Set(["python", "python3"]);
/** Mirrors registry.ts's getJavaScriptCommandNames() filter. */
const JS_NAMES = new Set(["js-exec", "node"]);

// AUTHORED DATA: doc-category curation + per-command descriptions. Descriptions
// carried over from the v5.0.0 doc are preserved verbatim where they were already
// per-command, and split faithfully where the old doc grouped several commands
// under one sentence (e.g. "cp / mv / rm | File copying, moving, and deletion.").

/**
 * @typedef {Object} Category
 * @property {string} title      Section heading.
 * @property {string} blurb      Italic one-liner under the heading.
 * @property {string} [details]  Relative link to a docs/registry/*.md deep dive.
 *                               Emitted only if the target file exists, so a
 *                               missing deep-dive cannot become a dead link.
 * @property {[string, string][]} commands  [registry name, description] pairs.
 */

/** @type {Category[]} */
const COMMAND_DOCS = [
  {
    title: "Basic I/O",
    blurb:
      "Reading and writing streams — the primitives everything else composes.",
    commands: [
      ["cat", "Concatenate files to standard output."],
      ["echo", "Write arguments to standard output."],
      ["printf", "Format and print data with printf(3) conversions."],
    ],
  },
  {
    title: "Core Operations & Filesystem",
    blurb: "Standard POSIX-compliant tools for file management and navigation.",
    details: "./registry/core_io.md",
    commands: [
      ["ls", "List directory contents with high-fidelity formatting."],
      ["pwd", "Print the current working directory."],
      ["mkdir", "Create directories."],
      ["rmdir", "Remove empty directories."],
      ["cp", "Copy files and directories."],
      ["mv", "Move and rename files and directories."],
      ["rm", "Delete files and directories."],
      ["chmod", "Change file permission bits."],
      ["stat", "Report file metadata."],
      ["ln", "Create symbolic and hard links."],
      ["readlink", "Resolve the target of a symbolic link."],
      ["touch", "Create files and update timestamps."],
      ["file", "Detect file type from content."],
      ["basename", "Strip directory and suffix from a path."],
      ["dirname", "Strip the last component from a path."],
      ["tree", "Visualize a directory tree."],
      ["du", "Report disk usage."],
      ["find", "Recursive file search with filter predicates."],
      ["tar", "Create and extract tar archives."],
      ["gzip", "Compress files with gzip."],
      ["gunzip", "Decompress gzip archives."],
      ["zcat", "Stream the decompressed contents of a gzip file."],
    ],
  },
  {
    title: "Text Processing",
    blurb: "Stream editing, filtering, and transformation utilities.",
    commands: [
      ["grep", "Pattern matching with basic regular expressions."],
      ["fgrep", "Pattern matching with fixed strings."],
      ["egrep", "Pattern matching with extended regular expressions."],
      ["rg", "Ultra-fast recursive code search (ripgrep)."],
      ["sed", "Stream editing with substitution and scripting."],
      ["awk", "Pattern-action text processing and reporting."],
      ["sort", "Sort lines of text."],
      ["uniq", "Report or filter repeated lines."],
      ["comm", "Compare two sorted files line by line."],
      ["cut", "Extract columns from each line."],
      ["paste", "Merge lines of files side by side."],
      ["join", "Relational join on a common field."],
      ["tr", "Translate or delete characters."],
      ["rev", "Reverse the characters on each line."],
      ["fold", "Wrap lines to a fixed width."],
      ["nl", "Number the lines of output."],
      ["expand", "Convert tabs to spaces."],
      ["unexpand", "Convert spaces to tabs."],
      ["column", "Format input into aligned columns."],
      ["tee", "Copy standard input to files and standard output."],
      ["tac", "Print lines in reverse order."],
      ["od", "Dump files in octal and other formats."],
      ["head", "Print the first lines of a file."],
      ["tail", "Print the last lines of a file."],
      ["wc", "Count lines, words, and bytes."],
      ["diff", "File comparison with unified diff output."],
      ["strings", "Extract printable strings from binary data."],
      ["split", "Split a file into pieces."],
    ],
  },
  {
    title: "Data Intelligence",
    blurb:
      "Advanced structured data processing tools running natively in WASM.",
    details: "./registry/data_intel.md",
    commands: [
      ["jq", "JSON stream processing and filtering."],
      ["yq", "YAML multi-document processing."],
      ["sqlite3", "In-memory relational logic over SQL."],
      ["xan", "High-performance CSV/TSV tabular data manipulation."],
      [
        "html-to-markdown",
        "Transform web content to markdown for LLM retrieval.",
      ],
    ],
  },
  {
    title: "Agentic Runtimes",
    blurb: "Sandbox isolation for arbitrary code execution.",
    details: "./registry/agentic_runtimes.md",
    commands: [
      ["python3", "Complete Python 3.11 environment (CPython on WASM)."],
      ["python", "Alias for `python3`."],
      ["js-exec", "Lightweight, extremely fast JavaScript logic (QuickJS)."],
      [
        "node",
        "Stub that exits non-zero and redirects the caller to `js-exec`; there is no Node runtime in the sandbox.",
      ],
    ],
  },
  {
    title: "Nexus Suite",
    blurb: "AI-native surgical editing, analysis, and code intelligence tools.",
    details: "./registry/nexus.md",
    commands: [
      ["ag-edit", "Atomic, line-based file editing for autonomous agents."],
      ["ag-diff", "Semantic diff engine with LLM-optimized summaries."],
      [
        "ag-snapshot",
        "Persistent environment state and filesystem checkpointing.",
      ],
      ["ag-analyze", "Structural script analysis and symbol extraction."],
      [
        "ag-hover",
        "Retrieve metadata and documentation for a specific symbol.",
      ],
      [
        "ag-explain",
        "Parse and explain the structure of complex shell commands.",
      ],
      [
        "ag-find-symbol",
        "Global search for symbol definitions and references.",
      ],
      [
        "ag-references",
        "Find all references to a symbol across the workspace.",
      ],
      ["ag-todo", "Persistent local task management for agent tracking."],
    ],
  },
  {
    title: "Agentic Tools",
    blurb: "Plan-mode, document conversion, search, and notebook management.",
    details: "./registry/agentic_tools.md",
    commands: [
      [
        "ag-plan",
        "Plan-mode orchestration: enter/exit read-only mode and manage multi-step plans.",
      ],
      [
        "ag-notebook",
        "Read, edit, and append cells in Jupyter Notebook (.ipynb) files.",
      ],
      [
        "ag-convert",
        "Intelligent document and image-to-markdown conversion with AI vision.",
      ],
      [
        "ag-grep",
        "High-performance recursive pattern search across the virtual filesystem.",
      ],
      [
        "ag-find-files",
        "High-performance recursive file search by name pattern.",
      ],
      ["ag-glob", "Fast glob pattern matching over the virtual filesystem."],
      [
        "ag-worktree",
        "Manage isolated virtual worktrees for parallel development.",
      ],
    ],
  },
  {
    title: "MCP & Orchestration",
    blurb: "Model Context Protocol integration and multi-agent coordination.",
    details: "./registry/mcp_orchestration.md",
    commands: [
      [
        "ag-mcp",
        "Connect to MCP servers, list tools, and invoke remote tool calls.",
      ],
      ["ag-spawn", "Start a sub-agent in the background with a given command."],
      ["ag-wait", "Synchronize with and collect output from a sub-agent."],
      ["ag-list-agents", "List all active sub-agents and their statuses."],
      [
        "ag-task",
        "Manage background tasks with lifecycle tracking (create, update, stop).",
      ],
      [
        "ag-team",
        "Manage multi-agent teams (create, add/remove agents, list).",
      ],
      ["ag-message", "Inter-agent messaging: send, broadcast, and read inbox."],
      [
        "ag-cron",
        "Manage scheduled cron jobs with standard 5-field expressions.",
      ],
    ],
  },
  {
    title: "Security & Proof",
    blurb: "Tools for cryptographic verification and auditing.",
    commands: [
      ["sha256sum", "Verify file integrity with high-entropy hashing."],
      ["sha1sum", "SHA-1 checksum generation and verification."],
      ["md5sum", "Legacy checksum verification."],
      ["base64", "Binary-to-text encoding for payload transport."],
    ],
  },
  {
    title: "External Integration",
    blurb: "Bridging the virtual sandbox with the outside world.",
    commands: [
      ["git", "Perform version control operations within the OverlayFS."],
      ["curl", "Audited network requests (isolated via proxy)."],
    ],
  },
  {
    title: "Shell & Environment",
    blurb:
      "Nested shells, environment inspection, and small process utilities. " +
      "These are registry commands; for interpreter-level builtins such as " +
      "`export` or `[[`, see the hand-authored section below.",
    commands: [
      ["bash", "Run a script or command string in a nested shell."],
      ["sh", "POSIX shell entry point backed by the same nested shell."],
      ["env", "Print the environment, or run a command with a modified one."],
      ["printenv", "Print environment variable values."],
      ["alias", "Define or list command aliases."],
      ["unalias", "Remove command aliases."],
      ["history", "List the command history."],
      ["xargs", "Build and run command lines from standard input."],
      ["which", "Locate a command on the search path."],
      ["help", "Show usage for builtin commands."],
      ["true", "Do nothing, successfully — exit status 0."],
      ["false", "Do nothing, unsuccessfully — exit status 1."],
      ["clear", "Clear the terminal screen."],
      ["whoami", "Print the effective user name."],
      ["hostname", "Print the sandbox host name."],
      ["date", "Print or format the current date and time."],
      ["sleep", "Delay for a specified duration."],
      ["timeout", "Run a command with a wall-clock limit."],
      ["time", "Measure the execution time of a command."],
      ["seq", "Print a sequence of numbers."],
      ["expr", "Evaluate an integer or string expression."],
      ["hello", "Minimal smoke-test command that greets the caller."],
    ],
  },
  {
    title: "Discoverability & Diagnostics",
    blurb:
      "Commands for exploring the shell's capabilities and verifying setup health.",
    details: "./registry/discoverability.md",
    commands: [
      ["commands", "List all available commands with categories and search."],
      ["about", "Show ag-bash features, architecture, and version."],
      ["doctor", "Run environment health checks and verify setup."],
    ],
  },
];

// REGISTRY LOADING

// An explicit allowlist of literal specifiers, one thunk each. Deliberately not
// a computed `import(base + name)`: a dynamic specifier is a module-loading
// code-execution primitive if it is ever tainted, and scripts/check-banned-
// patterns.js rejects it. Thunks (not top-level awaits) keep each import lazy so
// the dist fallback is only touched when the source import actually fails.
const importSrcCore = () =>
  import("../packages/bash/src/commands/definitions/core.ts");
const importSrcText = () =>
  import("../packages/bash/src/commands/definitions/text.ts");
const importSrcAgentic = () =>
  import("../packages/bash/src/commands/definitions/agentic.ts");
const importSrcRuntimes = () =>
  import("../packages/bash/src/commands/definitions/runtimes.ts");

const importDistCore = () =>
  import("../packages/bash/dist/commands/definitions/core.js");
const importDistText = () =>
  import("../packages/bash/dist/commands/definitions/text.js");
const importDistAgentic = () =>
  import("../packages/bash/dist/commands/definitions/agentic.js");
const importDistRuntimes = () =>
  import("../packages/bash/dist/commands/definitions/runtimes.js");

/**
 * @returns {Promise<{ names: Set<string>, source: string, counts: Map<string, number> }>}
 */
async function loadRegistry() {
  /** @type {{ core: any, text: any, agentic: any, runtimes: any }} */
  let mods;
  let source = "packages/bash/src (TypeScript type stripping)";
  try {
    mods = {
      core: await importSrcCore(),
      text: await importSrcText(),
      agentic: await importSrcAgentic(),
      runtimes: await importSrcRuntimes(),
    };
  } catch {
    // Node < 22.18 cannot import TypeScript at all.
    if (!existsSync(DIST_PROBE)) {
      throw new Error(
        "Cannot load the command registry.\n" +
          "  Node >= 22.18 reads packages/bash/src directly (native type stripping).\n" +
          "  On older Node, build first: pnpm --filter @ag-bash/bash build",
      );
    }
    mods = {
      core: await importDistCore(),
      text: await importDistText(),
      agentic: await importDistAgentic(),
      runtimes: await importDistRuntimes(),
    };
    source = "packages/bash/dist (built output; source import unavailable)";
  }

  // Mirrors registry.ts: getCommandNames() === core + text + agentic.
  const builtins = [
    ...mods.core.coreLoaders,
    ...mods.text.textLoaders,
    ...mods.agentic.agenticLoaders,
  ].map((def) => def.name);
  const network = mods.runtimes.networkLoaders.map((def) => def.name);
  const runtimeNames = mods.runtimes.runtimeLoaders.map((def) => def.name);
  const python = runtimeNames.filter((name) => PYTHON_NAMES.has(name));
  const javascript = runtimeNames.filter((name) => JS_NAMES.has(name));

  const counts = new Map([
    ["builtins", builtins.length],
    ["network", network.length],
    ["python", python.length],
    ["javascript", javascript.length],
  ]);

  return {
    names: new Set([...builtins, ...network, ...python, ...javascript]),
    source,
    counts,
  };
}

// RENDERING

/** @param {Set<string>} registryNames */
function assertDocsCoverRegistry(registryNames) {
  /** @type {Map<string, string>} name -> section title */
  const documented = new Map();
  const duplicates = [];
  for (const category of COMMAND_DOCS) {
    for (const [name] of category.commands) {
      if (documented.has(name)) duplicates.push(name);
      documented.set(name, category.title);
    }
  }

  const missing = [...registryNames].filter((n) => !documented.has(n)).sort();
  const extra = [...documented.keys()]
    .filter((n) => !registryNames.has(n))
    .sort();

  const problems = [];
  if (missing.length > 0) {
    problems.push(
      `${missing.length} registered command(s) have no COMMAND_DOCS entry: ${missing.join(", ")}\n` +
        "  Add one [name, description] line per command in scripts/gen-command-registry.mjs.\n" +
        "  Descriptions are never auto-invented — this is the one line of human upkeep.",
    );
  }
  if (extra.length > 0) {
    problems.push(
      `${extra.length} COMMAND_DOCS entr(ies) are not registered commands: ${extra.join(", ")}\n` +
        "  Remove them, or move them to a hand-authored section of the doc.",
    );
  }
  if (duplicates.length > 0) {
    problems.push(
      `Duplicate COMMAND_DOCS entr(ies): ${[...new Set(duplicates)].sort().join(", ")}`,
    );
  }
  if (problems.length > 0) throw new Error(problems.join("\n\n"));
}

/** @param {Map<string, number>} counts */
function renderInventory(counts) {
  const total =
    counts.get("builtins") +
    counts.get("network") +
    counts.get("python") +
    counts.get("javascript");

  const lines = [
    "",
    `This inventory is generated from \`packages/bash/src/commands/definitions/\` by`,
    "`scripts/gen-command-registry.mjs`. Do not hand-edit between the markers —",
    "run `node scripts/gen-command-registry.mjs` instead.",
    "",
    `**${total} commands** are registered: ${counts.get("builtins")} always-on builtins, ` +
      `${counts.get("network")} gated on network access, ${counts.get("python")} on the Python (WASM) ` +
      `runtime, and ${counts.get("javascript")} on the JavaScript (WASM) runtime.`,
    "",
  ];

  for (const category of COMMAND_DOCS) {
    const hasDetails =
      typeof category.details === "string" &&
      existsSync(resolve(DOC_DIR, category.details));
    const blurb = hasDetails
      ? `*${category.blurb} See [details](${category.details}).*`
      : `*${category.blurb}*`;

    lines.push("---", "", `## ${category.title}`, "", blurb, "");
    lines.push("| Command | Description |", "| :--- | :--- |");
    for (const [name, description] of category.commands) {
      lines.push(`| \`${name}\` | ${description} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// MAIN

function spliceBlock(doc, inventory) {
  const start = doc.indexOf(BEGIN_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `docs/COMMAND_REGISTRY.md is missing the generated inventory markers.\n` +
        `  Expected ${BEGIN_MARKER}\n` +
        `       ...  ${END_MARKER}`,
    );
  }
  return doc.slice(0, start + BEGIN_MARKER.length) + inventory + doc.slice(end);
}

async function main() {
  const isCheck = process.argv.includes("--check");
  const registry = await loadRegistry();
  assertDocsCoverRegistry(registry.names);

  const current = readFileSync(DOC_PATH, "utf-8");
  const updated = spliceBlock(current, renderInventory(registry.counts));

  if (isCheck) {
    if (updated !== current) {
      throw new Error(
        "docs/COMMAND_REGISTRY.md is out of date.\n" +
          "  Run: node scripts/gen-command-registry.mjs",
      );
    }
    console.log(
      `ok: docs/COMMAND_REGISTRY.md matches the registry (${registry.names.size} commands, read from ${registry.source})`,
    );
    return;
  }

  if (updated === current) {
    console.log(
      `unchanged: docs/COMMAND_REGISTRY.md already matches the registry (${registry.names.size} commands)`,
    );
    return;
  }

  writeFileSync(DOC_PATH, updated);
  console.log(
    `wrote: docs/COMMAND_REGISTRY.md (${registry.names.size} commands, read from ${registry.source})`,
  );
}

try {
  await main();
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  process.exitCode = 1;
  console.error(`gen-command-registry: ${detail}`);
}
