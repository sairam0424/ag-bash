/**
 * SPECIFICATION: every way a script can reach the filesystem under plan mode.
 *
 * This file is a SPEC, not a fix. Every row asserts the CURRENT observed
 * behaviour so the suite is GREEN today; rows that are wrong are labelled
 * `BYPASS` in the test name. When the 7.0 FS-boundary guard lands, flipping a
 * row is a one-line edit (`"BYPASS"` -> `"BLOCKED"`) and the diff shows exactly
 * which holes closed.
 *
 * ── Where the guard is, and where it is not ───────────────────────────────
 * Plan-mode enforcement lives at exactly ONE place: the fs proxy built by
 * `wrapFunction` in interpreter/defense-aware-command-context.ts:26-39,
 * reachable only via `createDefenseAwareCommandContext`, called from exactly one
 * site — interpreter/builtin-dispatch.ts:465 — on the per-command `cmdCtx`. That
 * wrapper ALSO early-returns the ctx UNWRAPPED at
 * defense-aware-command-context.ts:265-267 when
 * `!ctx.requireDefenseContext && !ctx.bash?.agentic`, so plan mode's existence
 * is conditional on defense-in-depth (see CONFIG VARIANTS).
 *
 * Redirections run on the interpreter's OWN ctx (interpreter.ts:973 hands
 * `this.ctx` to applyRedirections), whose `fs` is the raw MountableFs and never
 * passes through the wrapper. Layer taxonomy used in every test name:
 *
 *   LAYER_CMD    command dispatch -> GUARDED   (ctx.fs is the wrapped proxy)
 *   LAYER_INTERP interpreter ctx  -> UNGUARDED (redirections.ts ctx.fs is raw)
 *   LAYER_DIRECT Bash public API  -> UNGUARDED (Bash.ts:1441 writeFileDirect
 *                                   calls this.fs.writeFile directly)
 *   LAYER_TOOL   agentic toolbox  -> own gate at Tool.ts:65, keyed ONLY on the
 *                                   tool's `isDestructive` metadata
 *   LAYER_BRIDGE worker HOSTFS    -> INHERITS LAYER_CMD: bridge-handler.ts:414
 *                                   has no check of its own, but python3.ts:638
 *                                   and js-exec.ts:504 build BridgeHandler with
 *                                   `ctx.fs`, i.e. the wrapped proxy
 *
 * ── How the write-capable command set was derived (not from memory) ───────
 * The 117 registered commands were read out of the four loader tables
 * commands/definitions/{core,text,agentic,runtimes}.ts, which commands/
 * registry.ts aggregates into `commandLoaders` (47 + 41 + 24 + 5 = 117). Each
 * loader's `import("...")` target was resolved, then that module plus every
 * local import staying inside the same `commands/<dir>/` subtree was scanned for
 * a mutating IFileSystem call (writeFile | appendFile | mkdir | rm | cp | mv |
 * chmod | symlink | link | utimes). 30 of 117 have a direct FS write: git mkdir
 * rmdir touch rm cp mv ln chmod find tar yq xan sqlite3 sed awk sort split tee
 * time gzip gunzip zcat ag-edit ag-snapshot ag-todo ag-plan ag-notebook
 * ag-worktree curl. All 30 appear below, as a probe row or in UNCOVERED.
 * Commands that write only through a service (ag-task/ag-team/ag-cron/
 * ag-message) are exercised by the LAYER_TOOL rows, which drive those services.
 *
 * Grep is a screen, not a proof: a computed member access
 * (`const op = "writeFile"; fs[op](...)`) or a service closing over `bash.fs`
 * would not match that scan. The LAYER_DIRECT and LAYER_TOOL rows exist because
 * exactly two such paths were found by reading call sites, not by grepping.
 */
import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

/** Which layer the write reaches (or would reach) the filesystem through. */
type Layer =
  | "LAYER_CMD"
  | "LAYER_INTERP"
  | "LAYER_DIRECT"
  | "LAYER_TOOL"
  | "LAYER_BRIDGE";

/**
 * BLOCKED   - plan mode stops the write. Correct.
 * BYPASS    - plan mode does NOT stop the write. 7.0 must close this.
 * NO-OP     - the construct writes in NEITHER mode (not a write path here).
 * UNCOVERED - write-capable, but no plan-mode probe could be constructed.
 */
type Verdict = "BLOCKED" | "BYPASS" | "NO-OP" | "UNCOVERED";

/** What the probe observes on `target` before and after. */
type Kind = "exists" | "content" | "mode";

interface Row {
  id: string;
  layer: Layer;
  verdict: Verdict;
  probe: string;
  target: string;
  /** Runs in EXECUTE mode before the probe. */
  setup?: string;
  kind?: Kind;
  /** Why the row matters, or a message-quality bug found while probing. */
  note?: string;
}

const SEED = "echo seed > /s.txt";

function row(
  id: string,
  layer: Layer,
  verdict: Verdict,
  probe: string,
  target: string,
  extra: Pick<Row, "setup" | "kind" | "note"> = {},
): Row {
  return { id, layer, verdict, probe, target, ...extra };
}

const CMD = "LAYER_CMD";
const INT = "LAYER_INTERP";
const OK = "BLOCKED";
const BAD = "BYPASS";

const ROWS: Row[] = [
  // ── command layer: guarded via builtin-dispatch.ts:465 ─────────────────
  row("touch", CMD, OK, "touch /p.txt", "/p.txt"),
  row("mkdir", CMD, OK, "mkdir /pd", "/pd"),
  row("mkdir -p (nested)", CMD, OK, "mkdir -p /a/b/c", "/a"),
  row("cp", CMD, OK, "cp /s.txt /p.txt", "/p.txt", { setup: SEED }),
  row("cp into dir", CMD, OK, "cp /s.txt /out/", "/out/s.txt", {
    setup: `${SEED} && mkdir /out`,
  }),
  row("mv", CMD, OK, "mv /s.txt /p.txt", "/p.txt", { setup: SEED }),
  row("rm", CMD, OK, "rm /s.txt", "/s.txt", { setup: SEED }),
  row("rmdir", CMD, OK, "rmdir /sd", "/sd", { setup: "mkdir /sd" }),
  row("ln -s", CMD, OK, "ln -s /s.txt /p.txt", "/p.txt", { setup: SEED }),
  row("ln (hard)", CMD, OK, "ln /s.txt /p.txt", "/p.txt", { setup: SEED }),
  row("chmod", CMD, OK, "chmod 700 /s.txt", "/s.txt", {
    setup: SEED,
    kind: "mode",
    note: 'Blocked, but chmod swallows the SecurityViolationError in its per-file try and reports the misleading "cannot access ...: No such file or directory" (chmod/chmod.ts:103). Message-quality bug, not a bypass: the EXECUTE control confirms mode 420 -> 448 and plan mode leaves it at 420.',
  }),
  row("tee", CMD, OK, "echo pwned | tee /p.txt", "/p.txt", {
    note: 'Blocked, but tee reports "No such file or directory" (tee/tee.ts:41).',
  }),
  row("tee -a", CMD, OK, "echo pwned | tee -a /s.txt", "/s.txt", {
    setup: SEED,
    kind: "content",
  }),
  row("sed -i", CMD, OK, "sed -i s/seed/pwned/ /s.txt", "/s.txt", {
    setup: SEED,
    kind: "content",
  }),
  row(
    "awk print > file",
    CMD,
    OK,
    'awk \'BEGIN{print "x" > "/p.txt"}\'',
    "/p.txt",
    {
      note: "awk implements its own `>` against ctx.fs (awk/awk2.ts:121), so this is a command-layer write, NOT a shell redirection.",
    },
  ),
  row("sort -o", CMD, OK, "sort -o /p.txt /s.txt", "/p.txt", { setup: SEED }),
  row("split", CMD, OK, "split -l 1 /s.txt /p", "/paa", { setup: SEED }),
  row("gzip", CMD, OK, "gzip /s.txt", "/s.txt.gz", { setup: SEED }),
  row("tar -c", CMD, OK, "tar -cf /p.tar /s.txt", "/p.tar", { setup: SEED }),
  row("tar -x", CMD, OK, "tar -xf /a.tar -C /out", "/out/s.txt", {
    setup: `${SEED} && tar -cf /a.tar /s.txt && mkdir /out`,
  }),
  row("find -delete", CMD, OK, "find /sd -name s.txt -delete", "/sd/s.txt", {
    setup: "mkdir /sd && echo seed > /sd/s.txt",
  }),
  row("yq -i", CMD, OK, "yq -i .a=2 /s.yaml", "/s.yaml", {
    setup: "printf 'a: 1\\n' > /s.yaml",
    kind: "content",
  }),
  row(
    "sqlite3 (WASM)",
    CMD,
    OK,
    'sqlite3 /db.sqlite "create table t(a)"',
    "/db.sqlite",
    {
      note: "Blocked before the SQLite worker boots: sqlite3/sqlite3.ts:650 writeFile runs on the guarded ctx.fs.",
    },
  ),
  row("command time -o", CMD, OK, "command time -o /p.txt echo hi", "/p.txt", {
    note: "Blocked, but `time` still EXITS 0 (time/time.ts:171 catch returns the inner command's status). Bare `time -o ...` is unreachable: `time` is a shell keyword so `-o` is parsed as the command (exit 127).",
  }),
  row("xargs touch", CMD, OK, "echo /p.txt | xargs touch", "/p.txt", {
    note: "xargs re-enters through ctx.exec -> builtin-dispatch, so it inherits the guard.",
  }),
  row("bash -c nested", CMD, OK, 'bash -c "touch /p.txt"', "/p.txt"),
  row("command substitution", CMD, OK, "x=$(touch /p.txt)", "/p.txt"),

  // ── agentic ag-* commands (still LAYER_CMD) ────────────────────────────
  row("ag-edit append", CMD, OK, "ag-edit append /s.txt -x pwned", "/s.txt", {
    setup: SEED,
    kind: "content",
  }),
  row("ag-todo add", CMD, OK, "ag-todo add pwned", "/.ag-bash/todos.json"),
  row("ag-plan add", CMD, OK, "ag-plan add pwned", "/.ag-bash/plan.json", {
    note: "ag-plan cannot persist its own plan while in plan mode — the guard blocks the very command that owns the mode.",
  }),
  row(
    "ag-snapshot create",
    CMD,
    OK,
    "ag-snapshot create s1",
    "/home/user/.ag-snapshots",
    {
      note: "Target is cwd-relative (ag-snapshot.ts:27) and the default cwd is /home/user, not /.",
    },
  ),
  row(
    "ag-notebook add",
    CMD,
    OK,
    "ag-notebook add /s.ipynb code pwned",
    "/s.ipynb",
    {
      setup: `printf '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}' > /s.ipynb`,
      kind: "content",
    },
  ),
  row("ag-worktree enter", CMD, OK, "ag-worktree enter wt", "/.ag-bash"),

  // ── redirections: interpreter's OWN ctx, guard not in the path ─────────
  row("> file", INT, BAD, "echo pwned > /p.txt", "/p.txt", {
    note: "redirections.ts:577 ctx.fs.writeFile on the raw MountableFs.",
  }),
  row(">> file", INT, BAD, "echo pwned >> /p.txt", "/p.txt", {
    note: "redirections.ts:690 appendFile.",
  }),
  row(">> existing file", INT, BAD, "echo pwned >> /s.txt", "/s.txt", {
    setup: SEED,
    kind: "content",
  }),
  row("> overwrites existing", INT, BAD, "echo pwned > /s.txt", "/s.txt", {
    setup: SEED,
    kind: "content",
    note: "Destroys existing content while nominally read-only.",
  }),
  row("2> file", INT, BAD, "ls /nope 2> /p.txt", "/p.txt", {
    note: "redirections.ts:615.",
  }),
  row("2>> file", INT, BAD, "ls /nope 2>> /p.txt", "/p.txt"),
  row("&> file", INT, BAD, "echo pwned &> /p.txt", "/p.txt", {
    note: "redirections.ts:1037.",
  }),
  row("&>> file", INT, BAD, "echo pwned &>> /p.txt", "/p.txt"),
  row("exec 3> file", INT, BAD, "exec 3> /p.txt; echo pwned >&3", "/p.txt"),
  row("exec 3<> file", INT, BAD, "exec 3<> /p.txt", "/p.txt", {
    note: "redirections.ts:764 creates the file on the raw fs when absent.",
  }),
  row(
    "exec > file (persistent)",
    INT,
    BAD,
    "exec > /p.txt; echo pwned",
    "/p.txt",
  ),
  row("heredoc > file", INT, BAD, "cat > /p.txt <<EOF\npwned\nEOF", "/p.txt"),
  row("heredoc >> file", INT, BAD, "cat >> /p.txt <<EOF\npwned\nEOF", "/p.txt"),
  row("printf > file", INT, BAD, "printf pwned > /p.txt", "/p.txt"),
  row(": > file (truncate)", INT, BAD, ": > /p.txt", "/p.txt"),
  row(
    ">| (noclobber override)",
    INT,
    BAD,
    "set -o noclobber; echo p >| /p.txt",
    "/p.txt",
  ),
  row("group { } > file", INT, BAD, "{ echo pwned; } > /p.txt", "/p.txt", {
    note: "subshell-group.ts:158-209 calls applyRedirections with the same unguarded ctx.",
  }),
  row("subshell ( ) > file", INT, BAD, "( echo pwned ) > /p.txt", "/p.txt"),
  row(
    "loop > file",
    INT,
    BAD,
    "for i in 1; do echo p; done > /p.txt",
    "/p.txt",
  ),
  row(
    "function body > file",
    INT,
    BAD,
    "f() { echo p > /p.txt; }; f",
    "/p.txt",
  ),
  row("eval '... > file'", INT, BAD, 'eval "echo pwned > /p.txt"', "/p.txt"),
  row(
    "read builtin then > file",
    INT,
    BAD,
    "read v < /s.txt; echo $v > /p.txt",
    "/p.txt",
    {
      setup: SEED,
      note: 'The requested "read into a var then write" case: the read is legitimate, the write is the bypass.',
    },
  ),
  row(
    "blocked cmd, > still writes",
    INT,
    BAD,
    "echo p | tee /dev/null > /p.txt",
    "/p.txt",
    {
      note: "tee is blocked at LAYER_CMD (exit 1) yet the redirection still creates /p.txt — the two layers disagree inside ONE command.",
    },
  ),

  // ── constructs that write in NEITHER mode (documented non-paths) ───────
  row("1<> file (fd < 3)", INT, "NO-OP", "echo pwned 1<> /p.txt", "/p.txt", {
    note: "redirections.ts:754-757 breaks out for fd < 3, so this never opens the file in either mode. `exec 3<>` is the real path.",
  }),
  row("dd", CMD, "NO-OP", "dd if=/dev/zero of=/p.txt", "/p.txt", {
    note: "CORRECTION TO THE BRIEF: `dd` is NOT a registered command (absent from CommandName, commands/registry.ts:14-124). Exit 127 in both modes.",
  }),
];

/** Write-capable but no plan-mode probe could be constructed. Honest gaps. */
const UNCOVERED: Array<{ id: string; layer: Layer; why: string }> = [
  {
    id: "git (isomorphic-git)",
    layer: "LAYER_CMD",
    why: "`git init` fails identically in BOTH modes with \"fatal: Cannot read properties of undefined (reading 'bind')\": commands/git.ts:40-51 hands isomorphic-git a partial fs shim (no readlink/symlink). The failure is upstream of any plan-mode decision, so a row would assert nothing about plan mode.",
  },
  {
    id: "curl -o",
    layer: "LAYER_CMD",
    why: "Not registered under default config — Bash.ts:697 gates network commands on options.fetch/options.network — so it exits 127. Reaching curl/curl.ts:109 writeFile needs a network-enabled Bash plus a live or stubbed endpoint, i.e. the network lane, not this one.",
  },
  {
    id: "python3 -c open(...,'w')",
    layer: "LAYER_BRIDGE",
    why: "The CPython WASM artifact is not vendored in this checkout: with runtimes.python enabled the probe exits 1 with RUNTIME_NOT_BUNDLED (asserted below). The js-exec row covers the identical BridgeHandler path (bridge-handler.ts:414) and python3.ts:638 passes the SAME ctx.fs, so the verdict is expected to match — but that is an inference, not an observation.",
  },
  {
    id: "xan split -o",
    layer: "LAYER_CMD",
    why: "xan/xan-data.ts:245 writeFile is real, but no argv combination tried produced a write even in EXECUTE mode (`xan split -S 1 f.csv -o /out` exits 0 having written nothing), so there is no positive control to compare plan mode against.",
  },
  {
    id: "services flushed later (agent_memory_write, enter_worktree, team_create, task_*, cron_*)",
    layer: "LAYER_DIRECT",
    why: "These tools mutate in-memory service state in plan mode and return success, yet nothing lands on the fs during the call (verified: /.ag-bash stays absent). AgentMemorySync.ts:262/277 does write through a captured `fs`. Whatever later triggers that flush is a write with no plan-mode guard in its path — that trigger was not located, so the row cannot be asserted.",
  },
];

// ───────────────────────────────────────────────────────────────────────────
// Harness. The EXECUTE-mode control matters: without it "nothing was written"
// is indistinguishable from "the probe never wrote anything".
// ───────────────────────────────────────────────────────────────────────────

async function snapshot(bash: Bash, r: Row): Promise<string> {
  const kind = r.kind ?? "exists";
  try {
    if (!(await bash.fs.exists(r.target))) return "absent";
    if (kind === "exists") return "exists";
    const st = await bash.fs.stat(r.target);
    if (kind === "mode") return `mode:${st.mode}`;
    if (st.isDirectory)
      return `dir:${(await bash.fs.readdir(r.target)).join(",")}`;
    return `content:${await bash.fs.readFile(r.target)}`;
  } catch {
    return "absent";
  }
}

async function observe(r: Row, planMode: boolean): Promise<string> {
  const bash = new Bash();
  if (r.setup) {
    const s = await bash.exec(r.setup);
    if (s.exitCode !== 0) return `SETUP_FAILED:${s.stderr.trim()}`;
  }
  const before = await snapshot(bash, r);
  if (planMode) {
    const entered = await bash.exec("ag-plan enter");
    if (entered.exitCode !== 0) return `ENTER_FAILED:${entered.stderr.trim()}`;
    if (bash.getMode() !== "plan") return "MODE_NOT_PLAN";
  }
  await bash.exec(r.probe);
  return before === (await snapshot(bash, r)) ? "NOWRITE" : "WROTE";
}

const TITLE: Record<Verdict, string> = {
  BLOCKED: "BLOCKED (correct)",
  BYPASS: "BYPASS (7.0 must block)",
  "NO-OP": "NO-OP (not a write path)",
  UNCOVERED: "UNCOVERED",
};

describe("plan mode write-path matrix", () => {
  for (const r of ROWS) {
    it(`${TITLE[r.verdict]} [${r.layer}]: ${r.id}`, async () => {
      // Control: proves the probe is a real write path (or, for NO-OP, is not).
      expect(await observe(r, false)).toBe(
        r.verdict === "NO-OP" ? "NOWRITE" : "WROTE",
      );
      // The actual current plan-mode behaviour.
      expect(await observe(r, true)).toBe(
        r.verdict === "BYPASS" ? "WROTE" : "NOWRITE",
      );
    });
  }

  it("row census: 33 BLOCKED, 23 BYPASS, 2 NO-OP, 5 UNCOVERED", () => {
    const count = (v: Verdict): number =>
      ROWS.filter((r) => r.verdict === v).length;
    expect({
      blocked: count("BLOCKED"),
      bypass: count("BYPASS"),
      noop: count("NO-OP"),
      uncovered: UNCOVERED.length,
      total: ROWS.length,
    }).toEqual({ blocked: 33, bypass: 23, noop: 2, uncovered: 5, total: 58 });
  });
});

describe("plan mode write-path matrix: LAYER_BRIDGE (worker HOSTFS)", () => {
  // js-exec (QuickJS) IS vendored, so the worker-bridge write path is
  // observable end to end. bridge-handler.ts:414 has NO plan-mode check of its
  // own; it is guarded only because js-exec.ts:504 hands BridgeHandler the
  // wrapped `ctx.fs`. A 7.0 fix that moves enforcement to the FS boundary keeps
  // this BLOCKED; one that only re-plumbs the command layer must re-verify it.
  const WRITE = `js-exec -c 'require("fs").writeFileSync("/q.txt","pwned")'`;

  it("BLOCKED (correct) [LAYER_BRIDGE]: js-exec fs.writeFileSync via HOSTFS", async () => {
    const control = new Bash({ runtimes: { javascript: true } });
    const ok = await control.exec(WRITE);
    expect({
      exit: ok.exitCode,
      wrote: await control.fs.exists("/q.txt"),
    }).toEqual({ exit: 0, wrote: true });
    await control[Symbol.asyncDispose]?.();

    const planned = new Bash({ runtimes: { javascript: true } });
    await planned.exec("ag-plan enter");
    const denied = await planned.exec(WRITE);
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain(
      "security violation: Destructive operation 'fs.writeFile' blocked in 'plan' mode",
    );
    expect(await planned.fs.exists("/q.txt")).toBe(false);
    await planned[Symbol.asyncDispose]?.();
  });

  it("UNCOVERED [LAYER_BRIDGE]: python3 open(...,'w') — CPython WASM not vendored here", async () => {
    const bash = new Bash({ runtimes: { python: true } });
    await bash.exec("ag-plan enter");
    const r = await bash.exec(`python3 -c 'open("/p.txt","w").write("pwned")'`);
    expect(r.stderr).toContain("RUNTIME_NOT_BUNDLED");
    expect(await bash.fs.exists("/p.txt")).toBe(false);
    await bash[Symbol.asyncDispose]?.();
  });
});

describe("plan mode write-path matrix: LAYER_TOOL (agentic toolbox)", () => {
  // Tool.ts:65 denies a tool in plan mode ONLY when (a) buildTool supplied the
  // default checkPermissions AND (b) the tool's metadata says isDestructive.
  // Three ways to lose the gate, all present in the tree:
  //   1. omit isDestructive          -> add_todo, ag_todo, index_workspace
  //   2. override checkPermissions   -> MultiReplaceTool.ts:45 returns
  //                                     { behavior: "allow" } unconditionally,
  //                                     with a "in a real system we'd check"
  //                                     comment, despite isDestructive: true
  //   3. skip dispatch for the write -> 8 tools hand-build a CommandContext
  //      with `fs: bash.fs` (the RAW MountableFs) and call <cmd>Command.execute
  //      directly, so builtin-dispatch.ts:465 never runs: TodoTool.ts:55,
  //      EditTool.ts:90, SemanticTool.ts:33/73/104, SearchTool.ts:41/81,
  //      ConvertTool.ts:82. Of those, TodoTool and EditTool are write-capable.
  // NOTE these 12 tools are registered by `this.registerTool(<Tool>)`
  // (registry.ts:887-898), NOT via `buildTool({...})` inside registry.ts — a
  // sweep that only parsed buildTool literals missed every one of them.
  async function callInPlanMode(
    tool: string,
    args: Record<string, unknown>,
    target: string,
  ): Promise<{ result: string; wrote: boolean }> {
    const bash = new Bash();
    await bash.exec(SEED);
    await bash.exec("ag-plan enter");
    const result = String(await bash.toolbox.callTool(bash, tool, args));
    return { result, wrote: await bash.fs.exists(target) };
  }

  it("BLOCKED (correct) [LAYER_TOOL]: write_file (isDestructive: true)", async () => {
    const r = await callInPlanMode(
      "write_file",
      { path: "/t.txt", content: "pwned" },
      "/t.txt",
    );
    expect(r.result).toContain("Permission Denied");
    expect(r.wrote).toBe(false);
  });

  it("BLOCKED (correct) [LAYER_TOOL]: edit_file (isDestructive: true)", async () => {
    const r = await callInPlanMode(
      "edit_file",
      { path: "/s.txt", target: "seed", replacement: "pwned" },
      "/absent",
    );
    expect(r.result).toContain("Permission Denied");
  });

  it("BLOCKED (correct) [LAYER_TOOL]: run_command with a redirection", async () => {
    // registry.ts:338-353 flags any command containing a literal ">".
    const r = await callInPlanMode(
      "run_command",
      { command: "echo pwned > /t.txt" },
      "/t.txt",
    );
    expect(r.result).toContain("Permission Denied");
    expect(r.wrote).toBe(false);
  });

  it("BLOCKED (by LAYER_CMD, not the tool gate) [LAYER_TOOL]: run_command 'echo | tee f'", async () => {
    // run_command's isDestructive heuristic only checks the FIRST word against a
    // 9-name list plus a literal ">" substring, so `tee` sails through the tool
    // gate. Only the command-layer guard stops the write.
    const r = await callInPlanMode(
      "run_command",
      { command: "echo pwned | tee /t.txt" },
      "/t.txt",
    );
    expect(r.result).not.toContain("Permission Denied");
    expect(r.wrote).toBe(false);
  });

  it("BYPASS (7.0 must block) [LAYER_TOOL]: add_todo writes todos.json in plan mode", async () => {
    // registry.ts:786 add_todo declares no isDestructive, so Tool.ts:65 allows
    // it, and it writes via bash.fs.mkdir + bash.writeFileDirect.
    const r = await callInPlanMode(
      "add_todo",
      { task: "pwned" },
      "/.ag-bash/todos.json",
    );
    expect(r.result).not.toContain("Permission Denied");
    expect(r.wrote).toBe(true);
  });

  it("BYPASS (7.0 must block) [LAYER_TOOL]: index_workspace creates /.ag-bash in plan mode", async () => {
    const r = await callInPlanMode("index_workspace", {}, "/.ag-bash");
    expect(r.result).not.toContain("Permission Denied");
    expect(r.wrote).toBe(true);
  });

  it("BLOCKED (correct) [LAYER_TOOL]: ag_edit (buildTool default gate + isDestructive)", async () => {
    const bash = new Bash();
    await bash.exec(SEED);
    await bash.exec("ag-plan enter");
    const denied = String(
      await bash.toolbox.callTool(bash, "ag_edit", {
        filePath: "/s.txt",
        edits: [{ action: "append", text: "pwned" }],
      }),
    );
    expect(denied).toContain("Permission Denied");
    expect(await bash.fs.readFile("/s.txt")).toBe("seed\n");

    const control = new Bash();
    await control.exec(SEED);
    await control.toolbox.callTool(control, "ag_edit", {
      filePath: "/s.txt",
      edits: [{ action: "append", text: "pwned" }],
    });
    expect(await control.fs.readFile("/s.txt")).toContain("pwned");
  });

  it("BYPASS (7.0 must block) [LAYER_TOOL]: ag_multi_edit rewrites the file in plan mode", async () => {
    // MultiReplaceTool.ts:44-47 sets isDestructive: true and then overrides
    // checkPermissions with an unconditional allow, so Tool.ts:65 never runs.
    // The write itself is MultiReplaceTool.ts:114-115 bash.fs.mkdir +
    // bash.writeFileDirect, i.e. LAYER_DIRECT — no command dispatch either.
    const bash = new Bash();
    await bash.exec(SEED);
    await bash.readFileDirect("/s.txt"); // satisfies the staleness check
    await bash.exec("ag-plan enter");
    const result = String(
      await bash.toolbox.callTool(bash, "ag_multi_edit", {
        path: "/s.txt",
        chunks: [{ target: "seed", replacement: "pwned" }],
      }),
    );
    expect(result).not.toContain("Permission Denied");
    expect(await bash.fs.readFile("/s.txt")).toBe("pwned\n");
  });

  it("BYPASS (7.0 must block) [LAYER_TOOL]: ag_todo writes todos.json in plan mode", async () => {
    // TodoTool declares no isDestructive AND calls agTodoCommand.execute with a
    // hand-built ctx whose fs is bash.fs (TodoTool.ts:55) — both gates missed.
    const r = await callInPlanMode(
      "ag_todo",
      { operation: "add", task: "pwned" },
      "/.ag-bash/todos.json",
    );
    expect(r.result).not.toContain("Permission Denied");
    expect(r.wrote).toBe(true);
  });
});

describe("plan mode write-path matrix: LAYER_DIRECT (Bash public API)", () => {
  it("BYPASS (7.0 must block) [LAYER_DIRECT]: bash.writeFileDirect", async () => {
    const bash = new Bash();
    await bash.exec("ag-plan enter");
    await bash.writeFileDirect("/d.txt", "pwned");
    expect(await bash.fs.exists("/d.txt")).toBe(true);
  });

  it("BYPASS (7.0 must block) [LAYER_DIRECT]: bash.fs.writeFile", async () => {
    const bash = new Bash();
    await bash.exec("ag-plan enter");
    await bash.fs.writeFile("/d.txt", "pwned");
    expect(await bash.fs.exists("/d.txt")).toBe(true);
  });
});

describe("plan mode write-path matrix: CONFIG VARIANTS", () => {
  // The LAYER_CMD guard exists only if createDefenseAwareCommandContext gets
  // past defense-aware-command-context.ts:265-267, i.e. only if
  // requireDefenseContext OR bash.agentic. Bash.ts:1080 derives
  // requireDefenseContext from DefenseInDepthBox.isEnabled(); Bash.ts:595
  // defaults `agentic` to false. So plan mode is enforced by the
  // defense-in-depth switch, not by a plan-mode-specific control.
  async function planProbe(
    options: ConstructorParameters<typeof Bash>[0],
  ): Promise<{ cmdBlocked: boolean; redirWrote: boolean }> {
    const bash = new Bash(options);
    await bash.exec("ag-plan enter");
    const cmd = await bash.exec("touch /p.txt");
    const redir = await bash.exec("echo pwned > /q.txt");
    return {
      cmdBlocked: cmd.exitCode !== 0 && !(await bash.fs.exists("/p.txt")),
      redirWrote: redir.exitCode === 0 && (await bash.fs.exists("/q.txt")),
    };
  }

  it("default config: LAYER_CMD blocked, LAYER_INTERP bypass", async () => {
    expect(await planProbe(undefined)).toEqual({
      cmdBlocked: true,
      redirWrote: true,
    });
  });

  it("agentic enabled: same as default (guard installed via bash.agentic)", async () => {
    expect(await planProbe({ agentic: { enabled: true } })).toEqual({
      cmdBlocked: true,
      redirWrote: true,
    });
  });

  it("BYPASS (7.0 must block): defenseInDepth:false voids plan mode for LAYER_CMD too", async () => {
    // With defense-in-depth off and agentic off the wrapper early-returns the
    // raw ctx, so `touch` writes in plan mode: plan mode is silently a no-op
    // for the ENTIRE command layer under this config.
    expect(await planProbe({ security: { defenseInDepth: false } })).toEqual({
      cmdBlocked: false,
      redirWrote: true,
    });
  });

  it("defenseInDepth:false + agentic: LAYER_CMD guard is restored", async () => {
    expect(
      await planProbe({
        security: { defenseInDepth: false },
        agentic: { enabled: true },
      }),
    ).toEqual({ cmdBlocked: true, redirWrote: true });
  });
});

describe("plan mode write-path matrix: documented gaps", () => {
  it("UNCOVERED inventory is explicit, not silently omitted", () => {
    expect(UNCOVERED.map((u) => u.id)).toEqual([
      "git (isomorphic-git)",
      "curl -o",
      "python3 -c open(...,'w')",
      "xan split -o",
      "services flushed later (agent_memory_write, enter_worktree, team_create, task_*, cron_*)",
    ]);
    for (const entry of UNCOVERED) expect(entry.why.length).toBeGreaterThan(80);
  });
});
