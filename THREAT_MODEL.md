# Ag-Bash Security Threat Model (v6.1)

This document outlines the security architecture and threat mitigations for Ag-Bash.

> [!IMPORTANT]
> **Status: v6.1 — two documented controls are NOT enforced as shipped.**
>
> The primary layers (Architecture, Filesystem, Network, Parser/Execution limits,
> Prototype-pollution guards, re2js) are implemented and tested. Two boundaries
> previously documented here as enforced are **not** boundaries in 6.1 and are
> now labelled accordingly — read the `Status:` line on each entry before relying
> on it:
>
> | Boundary | 6.1 reality | Target |
> | :--- | :--- | :--- |
> | **TB7 — Plan mode** | **NOT a security boundary.** A shell redirection (`echo x > file`) writes through it. | enforced in 7.0 |
> | **TB8 — `ag-convert` "WASM-sandboxed Python"** | **False for this path.** `ag-convert` spawns **host** `python3` with the parent environment, and is registered by default. | opt-in behind `runtimes.hostPython` in 7.0 |
>
> Every threat entry below carries an explicit `Status:` line. An entry without
> `Status: ENFORCED` is a described intent, not a control you can rely on.

## Context

@ag-bash/bash is a TypeScript implementation of a bash interpreter with an in-memory virtual filesystem, designed for AI agents needing a secure, sandboxed bash environment. This document defines the full threat model: who the adversaries are, what they can target, what defenses exist, what gaps remain, and residual risks.

---

## 1. Threat Actors

### 1A. Untrusted Script Author (PRIMARY)

- **Who**: An AI agent or user submitting arbitrary bash scripts for execution
- **Capability**: Full control over the bash script input. Can craft any valid (or invalid) bash syntax
- **Goal**: Escape the sandbox, access the host filesystem, exfiltrate secrets, execute arbitrary code, cause denial of service, or escalate privileges
- **Trust level**: ZERO — the script is completely untrusted

### 1B. Malicious Data Source

- **Who**: External data consumed by scripts (HTTP responses, file content, stdin)
- **Capability**: Control over data that flows through expansion, variable assignment, command arguments
- **Goal**: Exploit the interpreter via crafted data (prototype pollution, injection via IFS, path traversal via filenames)
- **Trust level**: ZERO — data is untrusted

### 1C. Compromised Dependency

- **Who**: A supply-chain attacker modifying an npm dependency
- **Capability**: Arbitrary code execution at import time or via patched APIs
- **Goal**: Bypass sandbox from within the Node.js process
- **Trust level**: N/A — out of scope for runtime defenses but relevant for supply chain hardening

---

## 1.1 Trust Assumptions

The following components are **trusted** and outside the scope of @ag-bash/bash's runtime defenses:

- **Host-provided `fs`, `fetch`, `customCommands`, and transform plugins**: These are supplied by the embedding application. A compromised or malicious host hook can bypass all sandboxing by design — @ag-bash/bash protects untrusted *scripts*, not untrusted *hosts*.
- **The Node.js runtime and underlying OS**: @ag-bash/bash assumes the Node.js binary, V8, and OS kernel are not compromised. Exploits targeting V8 internals or kernel vulnerabilities are out of scope.
- **Dependencies**: Supply-chain attacks via npm dependencies are a deployment-level concern (addressed by lockfiles, audits, etc.), not a runtime defense.

**Partially trusted** (v2.6.0+):

- **External MCP servers**: When `@ag-bash/mcp-server` connects to external MCP servers via `ag-mcp`, those servers are treated as *partially trusted*. Their tool schemas are validated via Zod and their responses pass through strict JSON parsing, but the semantic content of tool results is accepted at face value once structurally validated. A compromised MCP server could return well-formed but malicious tool results — the ag-bash sandbox confines the blast radius, but the *meaning* of tool output is trusted by the orchestrating agent.

---

## 2. Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│ HOST PROCESS (Node.js)                                          │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ AG BASH SANDBOX                                           │  │
│  │                                                           │  │
│  │  ┌─────────────┐    ┌──────────────┐    ┌─────────────┐  │  │
│  │  │ Parser      │───▶│ AST          │───▶│ Interpreter │  │  │
│  │  │ (Lexer)     │    │              │    │             │  │  │
│  │  │ Limits:     │    │              │    │ Limits:     │  │  │
│  │  │ MAX_TOKENS  │    │              │    │ maxCmdCount │  │  │
│  │  │ MAX_INPUT   │    │              │    │ maxLoopIter │  │  │
│  │  │ MAX_DEPTH   │    │              │    │ maxCallDepth│  │  │
│  │  └─────────────┘    └──────────────┘    │ maxStrLen   │  │  │
│  │                                         └──────┬──────┘  │  │
│  │                                                │         │  │
│  │  ┌──────────────────┬──────────────────┬───────┴──────┐  │  │
│  │  │ Filesystem       │ Network          │ Commands     │  │  │
│  │  │ (InMemoryFs/     │ (Allow-list)     │ (Registry)   │  │  │
│  │  │  OverlayFs)      │ Default: OFF     │ 110+ built-in│  │  │
│  │  │ Symlinks: DENY   │                  │ ag-convert   │  │  │
│  │  └──────────────────┴──────────────────┴──────┬───────┘  │  │
│  │                                               │          │  │
│  │  ┌────────────────────────────────────────┐   │          │  │
│  │  │ Defense-in-Depth (SECONDARY)           │   │          │  │
│  │  │ AsyncLocalStorage context-aware        │   │          │  │
│  │  │   monkey-patching                      │   │          │  │
│  │  │ Blocks: Function, eval, setTimeout,    │   │          │  │
│  │  │   process.*, performance,              │   │          │  │
│  │  │   Module._resolveFilename,             │   │          │  │
│  │  │   __defineGetter__/__defineSetter__,   │   │          │  │
│  │  │   stdout/stderr                        │   │          │  │
│  │  │ Also: plan-mode write block —          │   │          │  │
│  │  │   COMMAND LAYER ONLY; a shell          │   │          │  │
│  │  │   redirection bypasses it (see TB7)    │   │          │  │
│  │  └────────────────────────────────────────┘   │          │  │
│  └───────────────────────────────────────────────┼──────────┘  │
│                                                  │             │
│  Host filesystem, process.env, network,          │             │
│  child_process                                   ▼             │
│                          spawnSync("python3", …,               │
│                            { env: { ...process.env } })        │
│                          ^ LEAVES THE SANDBOX (see TB8)        │
└─────────────────────────────────────────────────────────────────┘
```

> **Note on "No spawn()".** Earlier revisions of this diagram claimed the command
> registry contains no `spawn()` path. That is **not true as shipped.** Five
> non-`.test.ts` source files reference `node:child_process`:
>
> | File | Form | Reachable from an untrusted script? |
> |---|---|---|
> | `commands/ag-convert/ag-convert.ts:1` | `import { spawnSync }` | **Yes — registered by default.** See TB8, §4.11 |
> | `lsp/LSPConnection.ts:1` | `import { spawn }` | Only if the LSP service is used |
> | `services/McpClient.ts:205` | `await import(...)` (the `:5` import is type-only, erased) | Only if an MCP server is configured |
> | `cli/exec.ts:25` | `import { spawnSync }` | No — dev-only CLI path |
> | `comparison-tests/fixture-runner.ts:1` | `import { exec }` | No — test harness, not shipped in `dist` |
>
> The one that matters for the threat model is `ag-convert`, because it is
> **registered by default** and therefore reachable from an untrusted script.
>
> Note also what is *not* on this list: `commands/python3/worker.ts` names
> `"child_process"` only as an entry in a `Module._load` deny-list (:135-136),
> i.e. it blocks `require("child_process")` rather than using it. A grep for the
> module name matches that guard, so the string count is not the importer count.
> The
> no-bash→JavaScript-escape guarantee is unaffected — `ag-convert` spawns a
> *Python* interpreter, not `eval` — but "no child process" is a different claim,
> and it does not hold.

**TB1 — Script Input → Parser**: User script is completely untrusted. Parser must handle any input without crashing, hanging, or leaking information.
**Status: ENFORCED** — §3.1.

**TB2 — Interpreter → Filesystem**: The interpreter issues filesystem operations. The FS layer must confine all access to the sandbox root, block symlink traversal, and prevent writes to the real filesystem.
**Status: ENFORCED** — §3.3. This is the boundary to rely on for read-only or
confined sessions; **not** TB7's plan mode.

**TB3 — Interpreter → Network**: Network access disabled by default. When enabled, URLs must pass the allow-list.
**Status: ENFORCED** — §3.4.

**TB4 — Interpreter → Host Process**: The interpreter must never access host environment variables or reach Node.js internals (process.binding, require, import()).
**Status: PARTIALLY ENFORCED.** The `process.*` / module-loading / `eval` side is
enforced (§3.5, §3.6). The **"never spawn child processes" half is not**: the
default-registered `ag-convert` command spawns host `python3` (TB8, §4.11), and
the MCP stdio client and LSP client each spawn a server process when the embedder
uses them. Earlier revisions of this document asserted the stronger claim; it was
wrong.

**TB5 — Data → Variable/Key Space**: User-controlled data becomes JS object keys (env vars, AWK variables, associative array keys). Must use null-prototype objects or Maps to prevent prototype pollution.
**Status: ENFORCED** — §3.9.

**TB6 — MCP Client → External Server** (v2.6.0+)
**Status: ENFORCED at the transport layer; semantic content trusted (see residual
risk).** The `@ag-bash/mcp-server` connects to external MCP servers via JSON-RPC 2.0 over stdio and HTTP transports. External servers are untrusted at the transport layer: tool schemas are validated via Zod at registration time, and responses pass through strict JSON parsing before reaching the interpreter. However, a compromised MCP server could return structurally valid but semantically malicious tool results (e.g., a `read_file` tool returning fabricated content). The ag-bash sandbox confines execution, but the orchestrating agent may act on the poisoned data. **Residual risk**: Semantically valid but malicious tool results that pass structural validation.

**TB7 — Plan Mode → Tool Dispatch** (v2.6.0+)

> **Status: NOT ENFORCED in 6.1. Plan mode is a UX affordance, not a security
> boundary. Enforced in 7.0.**
>
> Do not use plan mode to contain an untrusted script or an untrusted agent. If
> you need a read-only session in 6.1, construct the instance with
> `new OverlayFs({ root, readOnly: true })` — that *is* enforced (TB2):
> `assertWritable()` throws `EROFS` on every write path, including the shell
> redirection that bypasses plan mode.
>
> Two things that do **not** work and must not be substituted for it:
> `InMemoryFs` has no `readOnly` option at all and accepts writes (it is the
> default FS, and it is what makes the plan-mode bypass above observable); and
> omitting the writable overlay does not help, because `OverlayFs` always keeps
> an in-memory layer — `readOnly: true` is the only thing that enforces.
>
> Known rough edge: a refused write currently rejects the `exec()` promise with a
> raw `Error` rather than returning a non-zero `BashExecResult`, so callers must
> wrap it in `try/catch`.

*Intent*: while `bash.getMode() === "plan"`, destructive operations (file writes,
`rm`, `chmod`, network mutations) are refused so an agent can plan without
mutating state.

*What is actually enforced in 6.1*: a write block on the **command layer only**.
`createDefenseAwareCommandContext()`
(`src/interpreter/defense-aware-command-context.ts:26-40`) wraps the `fs` handed
to a builtin and throws `SecurityViolationError` when the wrapped method name
matches `writeFile|appendFile|mkdir|rm|cp|mv|chmod|symlink|link|utimes|restore`.
It is installed at exactly one dispatch site,
`src/interpreter/builtin-dispatch.ts:465`. So `touch`, `rm`, `tee`, and `ag-edit`
are refused — **but a redirection is not.** Observed transcript (`ag-plan enter`
is the only supported way to enter the mode; there is no `--mode` CLI flag):

```
$ ag-plan enter
Entered plan mode. You are now in read-only mode.
$ ag-plan status
Current mode: plan

$ touch /a.txt                                          # exit 1  — refused
touch: cannot touch '/a.txt': security violation: Destructive operation
'fs.writeFile' blocked in 'plan' mode.

$ ag-edit replace /main.sh --line 1 --text bar           # exit 1  — refused
ag-edit: failed to write /main.sh: security violation: Destructive operation
'fs.writeFile' blocked in 'plan' mode.

$ echo pwned > /b.txt                                    # exit 0  — WRITTEN
$ cat /b.txt
pwned
```

*The bypass*: **a shell redirection reaches the filesystem through the
interpreter's own context, not the command's.**
Redirections are applied by `applyRedirections(this.ctx, …)` — 6 call sites in
`src/interpreter/interpreter.ts` plus more in `control-flow.ts`, `functions.ts`,
and `subshell-group.ts` (`grep -n applyRedirections src/interpreter/`) — which is handed the raw
`InterpreterContext` and calls `ctx.fs.writeFile()` / `ctx.fs.appendFile()`
directly (`src/interpreter/redirections.ts:577`, `:615`, `:690`, `:1037`, …).
That `ctx.fs` is never passed through
`createDefenseAwareCommandContext()`, so the guard never runs. Every
redirection form is affected: `>` (create), `>` (truncate an existing file, e.g.
`: > file`), `>>` (append), and `&>`/`2>`.

*Two further gaps in the guard that does exist*:

- It is **coupled to defense-in-depth**. `requireDefenseContext` is computed from
  `DefenseInDepthBox.isEnabled()` (`src/Bash.ts`, in
  `buildExecutionPipeline()`), and
  `createDefenseAwareCommandContext()` early-returns when neither
  `requireDefenseContext` nor `bash.agentic` is set
  (`defense-aware-command-context.ts:265-267`). With
  `{ security: { defenseInDepth: false } }`, `touch /c.txt` succeeds in plan mode.
- It is **absent in browser builds**. `isEnabled()` returns `false` whenever
  `IS_BROWSER` (`src/security/defense-in-depth-box.ts:397-400`), so the browser
  bundle has no plan-mode write block at all unless `agentic: true` is set.

*`PermissionManager` is dead code in 6.1.* `src/services/PermissionManager.ts`
implements the rule engine, the `mode: "plan"` deny rule, and the strict
allowlist described in earlier revisions of this document. It is constructed in
the `Bash` constructor and assigned to the public `this.permissionManager` field
(`src/Bash.ts`), and
**`checkPermission()` is called from nowhere** in either package or in any
test. `enableStrictMode()`, `setAllowedPlanTools()`, and `setHandler()` are
likewise never called. The plan-mode denial that *does* fire comes from the
`defense-aware-command-context` wrapper above, and — for agent-runtime tool calls
only — from `ToolboxTool.checkPermissions`'s default
(`src/agentic/Tool.ts:62-72`) and `RunLoop.isGated()`
(`src/agent-runtime/RunLoop.ts:248`). Neither of those sees a shell redirection.

**Residual risk**: plan mode does not prevent filesystem mutation. Additionally,
custom commands registered via `customCommands` execute as opaque JS functions
and are not subject to any plan-mode check.

**Planned for 7.0**: move the plan-mode decision behind a single choke point that
every write path (command dispatch *and* redirection *and* heredoc) must pass,
and either wire `PermissionManager` into that choke point or delete it.

---

**TB8 — ag-convert → Document Processing** (v2.6.0+)

> **Status: the "WASM-sandboxed Python" claim is FALSE for this path in 6.1.
> `ag-convert` spawns HOST `python3`. Planned to move behind a
> `runtimes.hostPython` opt-in in 7.0.**

The `ag-convert` command processes untrusted documents (PDF, DOCX, HTML) by
routing them through Python-based converters (Docling/MarkItDown). Earlier
revisions of this document stated that this Python ran inside the CPython
Emscripten WASM sandbox of §4.7. **It does not.** `ag-convert` shells out to the
host interpreter:

- `spawnSync("python3", [bridgePath, realFilePath, …], { env: { ...process.env } })`
  — `src/commands/ag-convert/ag-convert.ts:205-209`. The **full parent
  environment is inherited**, including any API keys, cloud credentials, and
  tokens present in `process.env`.
- `ag-convert --setup` additionally runs `uv pip install --system …` or
  `python3 -m pip install … --break-system-packages` with `shell: true` and
  `env: { ...process.env }` (`ag-convert.ts:283-322`), i.e. it mutates the host
  Python environment. It also reads `process.env.HOME` (`ag-convert.ts:259`).
- **It is registered by default**, with no opt-in flag: entry in `agenticLoaders`
  (`src/commands/definitions/agentic.ts:63-67`), merged into `commandLoaders` at
  `src/commands/registry.ts:139`. A plain `new Bash()` can run it.

None of the §4.7 build-time or runtime restrictions apply to this path: there is
no Emscripten VFS, no fresh-Worker-per-execution, no `maxPythonTimeoutMs`, and no
`/host` mount indirection. Whatever the host `python3` can do — read the host
filesystem, open sockets, `os.system()` — the converter can do.

*What IS enforced*: **path translation is fail-closed.** `ag-convert` resolves the
argument to a virtual path, then requires `ctx.fs.toRealPath()` to return a real
host path; if it returns `null` (as `MountableFs`/`InMemoryFs` do for any
purely in-memory path) the command refuses rather than handing the untranslated
string to the host (`ag-convert.ts:135-170`):

```
$ ag-bash -c 'mkdir -p /etc && echo secret > /etc/passwd; ag-convert /etc/passwd'
ag-convert: /etc/passwd exists only in the virtual filesystem and has no host path.
ag-convert delegates to host python3, which cannot read virtual paths. …
```

This closes the earlier defect in which creating `/etc/passwd` *inside* the
sandbox caused `ag-convert` to return the **host's** `/etc/passwd` (and
`--analyze` to leak host stat metadata with no third-party Python dependency at
all). It is a regression test, not a comment:
`src/commands/ag-convert/ag-convert.hostpath.test.ts`. So the reachable surface is
confined to files the embedder has *deliberately* mounted — but on those files
the converter runs as a full host process.

**Residual risk**:
1. Host code execution by design. A crafted document that exploits a
   Docling/MarkItDown/native-codec parser bug executes on the host with the
   embedder's own privileges, outside every ag-bash sandbox layer.
2. Environment exfiltration. `env: { ...process.env }` hands the whole parent
   environment to the converter; a hostile or trojaned `docling`/`markitdown`
   wheel reads it directly.
3. No timeout and no memory ceiling on the spawned process (`maxBuffer` caps
   captured output at 50 MB; it does not bound CPU or RSS).
4. `--setup` performs an unpinned network package install into the host Python
   environment.

**Mitigation available today**: do not mount host directories you would not hand
to `python3` directly; and if you do not need document conversion, launch under
the Node.js Permission Model *without* granting `child_process` (see
`SECURITY.md` §4 — note that this also disables MCP stdio servers and LSP).

**Planned for 7.0**: gate `ag-convert`'s host-`python3` path behind an explicit
`runtimes.hostPython` opt-in (default off), pass an explicit minimal environment
instead of `{ ...process.env }`, and add a wall-clock timeout.

**TB9 — Agentic Healer → Auto-Remediation** (v2.6.0+)
**Status: ENFORCED in the default `keyword` mode; NOT a boundary in `llm` mode
(see residual risk).** The `AgenticHealer` observes script failures and suggests recovery commands. In the default `keyword` mode, suggestions are generated via fixed keyword matching against a scored tool registry — no external model is involved. Suggestions are advisory only (displayed to the user/agent, not auto-executed) unless the host explicitly configures auto-execution. **Residual risk**: If `llm` mode is enabled, the healer delegates suggestion generation to an LLM. An attacker who controls stderr output (e.g., via a crafted script that writes attacker-controlled error messages) could prompt-inject the LLM into suggesting malicious remediation commands. The `keyword` default mode is immune to this vector.

---

## 3. Attack Surface Inventory

### 3.1 Script Input (Parser)

| Vector | Description | Defense | Files |
| :--- | :--- | :--- | :--- |
| Token bomb | Script with pathological tokenization | MAX_TOKENS (100K) | `src/parser/types.ts` |
| Parser stack overflow | Deeply nested constructs | MAX_PARSER_DEPTH (200), MAX_PARSE_ITERATIONS (1M) | `src/parser/types.ts` |
| Oversized input | Very large scripts | MAX_INPUT_SIZE (1MB) | `src/parser/types.ts` |
| Heredoc bomb | Huge heredoc content | maxHeredocSize (10MB) | `src/limits.ts` |
| Malformed input | Invalid bash syntax | Parser returns errors, doesn't crash | `src/parser/parser.ts` |

### 3.2 Expansion & Substitution

| Vector | Description | Defense | Files |
|--------|-------------|---------|-------|
| Brace expansion bomb | `{1..999999}` | maxBraceExpansionResults (10K) | `src/limits.ts` |
| Cmd substitution depth | `$($($($(…))))` | maxSubstitutionDepth (50) | `src/limits.ts` |
| String growth | `${x//a/aaaa}` in loop | maxStringLength (10MB) + mid-loop check | `src/interpreter/expansion/parameter-ops.ts` |
| Glob bomb | `**/*` across large FS | maxGlobOperations (100K) | `src/limits.ts` |
| Glob depth bomb | `**/**/**/**/**/**/x` | MAX_GLOBSTAR_SEGMENTS (5) rejects excessive `**` segments | `src/shell/glob.ts` |
| Var indirection chain | `a=b; b=c; …` 100+ deep | Hardcoded depth > 100 check | `src/interpreter/arithmetic.ts` |
| IFS injection | Custom IFS to split commands | IFS only affects word splitting, not parsing | `src/interpreter/helpers/ifs.ts` |
| Arithmetic overflow | `$((2**63))` | Clamped to MAX_SAFE_INTEGER, no 64-bit | `src/parser/arithmetic-primaries.ts` |
| Division by zero | `$((1/0))` | ArithmeticError thrown | `src/interpreter/arithmetic.ts` |

### 3.3 Filesystem

| Vector | Description | Defense | Files |
|--------|-------------|---------|-------|
| Path traversal | `../../etc/passwd` | Path normalization + root containment via `isPathWithinRoot()` | `src/fs/real-fs-utils.ts` |
| Symlink escape | Symlink pointing outside root | Default-deny (`allowSymlinks: false`) | `src/fs/overlay-fs/overlay-fs.ts` |
| Null byte injection | `file\x00.txt` | `validatePath()` rejects null bytes | `src/fs/real-fs-utils.ts` |
| TOCTOU race | Check-then-use timing gap | Gate returns canonical path for immediate use | `src/fs/real-fs-utils.ts` |
| Write to host FS | Persisting malicious files | OverlayFs writes to memory only | `src/fs/overlay-fs/overlay-fs.ts` |
| /proc /sys access | Reading host process info | Virtual FS doesn't expose real /proc | `src/fs/overlay-fs/overlay-fs.ts` |
| Broken symlink write | Write through broken symlink | Extra `lstat()` on leaf component | `src/fs/real-fs-utils.ts` |
| Real path disclosure | Error messages reveal host paths | `sanitizeError()` strips real paths from ErrnoException; `sanitizeSymlinkTarget()` strips absolute paths | `src/fs/overlay-fs/overlay-fs.ts`, `src/fs/real-fs-utils.ts` |

### 3.4 Network

| Vector | Description | Defense | Files |
|--------|-------------|---------|-------|
| Arbitrary access | `curl evil.com` | Network disabled by default; curl only registered when NetworkConfig provided | `src/commands/registry.ts` |
| SSRF via redirects | Redirect to internal service | Each redirect validated against allow-list; manual redirect handling | `src/network/fetch.ts` |
| Response bomb | Huge response body | maxResponseSize (10MB) enforced via Content-Length and streaming | `src/network/fetch.ts` |
| Protocol restriction | Only http/https allowed | Allow-list rejects all other protocols | `src/network/allow-list.ts` |
| URL manipulation | `https://evil.com@good.com` | Full URL parsing via `new URL()` before matching | `src/network/allow-list.ts` |
| Header pollution | Malicious response headers | Response headers stored in `Object.create(null)` | `src/network/fetch.ts` |

### 3.5 Code Execution Escape

| Vector | Description | Defense | Files |
|--------|-------------|---------|-------|
| Function constructor | `new Function("code")` | Blocked by defense-in-depth proxy | `src/security/blocked-globals.ts` |
| eval() | Direct/indirect eval | Blocked by defense-in-depth proxy | `src/security/blocked-globals.ts` |
| .constructor.constructor | `{}.constructor.constructor` | `Function.prototype.constructor` patched | `src/security/defense-in-depth-box.ts` |
| Async/Generator constructors | `async function(){}.constructor` | All async/generator function constructors patched | `src/security/defense-in-depth-box.ts` |
| setTimeout(string) | Code execution via string arg | setTimeout entirely blocked | `src/security/blocked-globals.ts` |
| process.binding() | Access native modules | Blocked by defense-in-depth proxy | `src/security/blocked-globals.ts` |
| process.dlopen() | Load native addons | Blocked by defense-in-depth proxy | `src/security/blocked-globals.ts` |
| Module._load() | CJS module loading | Blocked by defense-in-depth proxy | `src/security/defense-in-depth-box.ts` |
| Module._resolveFilename() | Module resolution (require + import) | Blocked by defense-in-depth proxy — partially mitigates `import()` for file-based specifiers | `src/security/defense-in-depth-box.ts` |
| process.mainModule | Access main module (CJS) | Blocked via defineProperty getter | `src/security/defense-in-depth-box.ts` |
| Error.prepareStackTrace | Leak Function via stack frames | Set blocked via defineProperty | `src/security/defense-in-depth-box.ts` |
| WebAssembly | Compile/run arbitrary code | Blocked by defense-in-depth proxy | `src/security/blocked-globals.ts` |
| Proxy constructor | Create intercepting proxies | Blocked by defense-in-depth proxy | `src/security/blocked-globals.ts` |
| WeakRef/FinalizationRegistry | GC observation/side channels | Blocked by defense-in-depth proxy | `src/security/blocked-globals.ts` |
| process.chdir() | Confuse CWD tracking | Blocked by defense-in-depth proxy | `src/security/blocked-globals.ts` |
| **dynamic import()** | `import('/tmp/evil.js')` | **BLOCKED**: `Module._resolveFilename` blocks file specifiers; ESM loader hooks block `data:`/`blob:` URLs (Node.js 20.6+; see §4.1) | `src/security/defense-in-depth-box.ts` |
| child_process | spawn/exec/fork | **NOT BLOCKED.** No bash builtin gives a script *arbitrary* argv, but `child_process` is referenced by 5 non-`.test.ts` source files (table in §2) and `ag-convert` — which spawns host `python3` — is registered by default. See TB8 and §4.11. | `commands/ag-convert/ag-convert.ts:205`, `lsp/LSPConnection.ts:1`, `services/McpClient.ts:205` |

### 3.6 Information Disclosure

| Vector | Description | Defense | Files |
|--------|-------------|---------|-------|
| process.env | Leak API keys, secrets | Blocked by defense-in-depth | `src/security/blocked-globals.ts` |
| process.argv | CLI args with secrets | Blocked by defense-in-depth | `src/security/blocked-globals.ts` |
| process.execPath | Reveal Node.js path | Blocked via defineProperty | `src/security/defense-in-depth-box.ts` |
| process.stdout/stderr | Bypass interpreter output | Blocked by defense-in-depth (workers); skipped in main thread due to console.log dependency | `src/security/blocked-globals.ts` |
| process.connected | IPC connection status | Blocked in **worker contexts only** (WorkerDefenseInDepth) | `src/security/defense-in-depth-box.ts` |
| process.send | IPC messaging to parent | Blocked in **worker contexts only** (WorkerDefenseInDepth); main thread skipped to avoid interfering with test runners/process managers | `src/security/blocked-globals.ts` |
| process.channel | IPC channel access | Blocked in **worker contexts only** (WorkerDefenseInDepth); main thread skipped for same reason | `src/security/blocked-globals.ts` |
| Host PID/UID | Expose process identity | Virtualized (processInfo option, defaults: pid=1, uid=1000) | `src/Bash.ts` |
| hostname/whoami/uname | System enumeration | Return generic/virtual values | `src/commands/hostname/` |
| Error messages | Reveal file paths | `sanitizeError()` in FS layers + `sanitizeErrorMessage()` at all error choke points (builtin-dispatch, Bash.ts, CLI, Python bridge) | `src/fs/real-fs-utils.ts`, `src/interpreter/builtin-dispatch.ts`, `src/Bash.ts`, `src/cli/@ag-bash/bash.ts` |
| Timing side-channels | hrtime, cpuUsage, memoryUsage | Blocked by defense-in-depth | `src/security/blocked-globals.ts` |
| performance.now() | Sub-ms timing for side-channels | Blocked by defense-in-depth; internal uses pre-capture `_performanceNow` | `src/security/blocked-globals.ts`, `src/timers.ts` |

### 3.7 Denial of Service

| Vector | Description | Defense | Files |
|--------|-------------|---------|-------|
| Infinite loop | `while true; do :; done` | maxLoopIterations (10K) | `src/limits.ts` |
| Fork bomb | Recursive function calls | maxCallDepth (100) | `src/limits.ts` |
| Command flood | Thousands of commands | maxCommandCount (10K) | `src/limits.ts` |
| Memory exhaustion | String/array growth | maxStringLength (10MB), maxArrayElements (100K) | `src/limits.ts` |
| Regex DoS (ReDoS) | Catastrophic backtracking | re2js (linear-time regex engine) | `src/regex/user-regex.ts` |
| process.exit() | Terminate host process | Blocked by defense-in-depth | `src/security/blocked-globals.ts` |
| process.abort() | Crash host process | Blocked by defense-in-depth | `src/security/blocked-globals.ts` |
| process.kill() | Signal host/other procs | Blocked by defense-in-depth | `src/security/blocked-globals.ts` |
| AWK/SED loops | Runaway text processing | maxAwkIterations (10K), maxSedIterations (10K) | `src/limits.ts` |
| Source depth bomb | Self-sourcing script | maxSourceDepth (100) | `src/limits.ts`, `src/interpreter/builtins/source.ts` |
| FD exhaustion | `exec N>/dev/null` in loop | `checkFdLimit()` enforces maxFileDescriptors (1024) before every `fileDescriptors.set()` | `src/interpreter/helpers/result.ts` |
| Glob `**` depth | `**/**/**/**/**/**/x` | MAX_GLOBSTAR_SEGMENTS (5) rejects patterns with excessive recursive segments | `src/shell/glob.ts` |

### 3.8 Privilege Escalation

| Vector | Description | Defense | Files |
|--------|-------------|---------|-------|
| process.setuid() | Change user ID | Blocked by defense-in-depth | `src/security/blocked-globals.ts` |
| process.setgid() | Change group ID | Blocked by defense-in-depth | `src/security/blocked-globals.ts` |
| process.umask() | Modify file permissions | Blocked by defense-in-depth | `src/security/blocked-globals.ts` |
| chmod/chown | Change file permissions | Operates on virtual FS only | `src/commands/chmod/` |

### 3.9 Prototype Pollution

| Vector | Description | Defense | Files |
|--------|-------------|---------|-------|
| Environment variables | `__proto__`, `constructor` as var names | `Map<string, string>` for env storage | `src/Bash.ts`, `src/helpers/env.ts` |
| AWK variables | AWK field/var names | `Object.create(null)` throughout | `src/commands/awk/interpreter/context.ts` |
| Associative arrays | User-controlled keys | Null-prototype objects | `src/interpreter/` |
| JQ/query field access | JSON keys from data | `DANGEROUS_KEYS` Set + `safeGet()`/`safeSet()` | `src/commands/query-engine/safe-object.ts` |
| HTTP response headers | Header names from responses | `Object.create(null)` for header objects | `src/network/fetch.ts` |
| Env export to commands | Passing env to subprocesses | `mapToRecord()` produces null-prototype objects | `src/helpers/env.ts` |
| `__defineGetter__`/`__defineSetter__` | Inject getters/setters on prototypes | Blocked by defense-in-depth (strategy: "throw") | `src/security/blocked-globals.ts` |
| `__lookupGetter__`/`__lookupSetter__` | Introspect prototype getters/setters | Blocked by defense-in-depth (strategy: "throw") | `src/security/blocked-globals.ts` |
| JSON/Math mutation | Poison shared utility objects | Frozen by defense-in-depth (strategy: "freeze") | `src/security/blocked-globals.ts` |

### 3.10 Orchestration (Sub-agents)

| Vector | Description | Defense | Files |
|--------|-------------|---------|-------|
| Agent bomb | Spawning infinite sub-agents | `maxSubAgents` (10) limit in `AgentManager` | `src/limits.ts`, `src/services/AgentManager.ts` |
| Nested agents | Agent A spawns B spawns C... | `maxAgentNesting` (3) depth tracking | `src/limits.ts`, `src/services/AgentManager.ts` |
| State leakage | Sub-agent accessing parent's memory | Isolated `Bash` instances; shared FS is virtual only; environment filtered | `src/services/AgentManager.ts` |
| Resource monopolization | Sub-agents consuming all host resources | Aggregate resource accounting across sub-agent tree (Residual) | `src/limits.ts` |

### 3.11 MCP Integration

| Vector | Description | Defense | Files |
|--------|-------------|---------|-------|
| Malicious tool schema | Server returns oversized or complex schema | Zod validation + parameter depth limits during registration | `src/agentic/BashToolbox.ts` |
| Tool injection | Overwriting built-in secure tools | `registerTool` rejects overwriting core built-ins | `src/agentic/BashToolbox.ts` |
| Unauthorized connection | Connecting to internal/private services | `ag-mcp` connection validation + standard Network allow-list | `src/commands/ag-mcp/ag-mcp.ts` |
| Tool call pollution | Server returns malicious JSON responses | Strict JSON parsing + validation before returning to interpreter | `src/services/McpClient.ts` |

---

## 4. Known Gaps & Residual Risks

### 4.1 Dynamic import() Mitigated (Three Layers)

**Risk**: LOW (comprehensively mitigated on Node.js 20.6+)

Dynamic `import()` is a language-level keyword, not a property on any object. It cannot be intercepted by Proxy or defineProperty. However, it CAN be intercepted via Node.js ESM loader hooks.

**Attack scenario**: If attacker achieves JS code execution → `import('data:text/javascript,...')` → full escape.

**Mitigations** (three layers):
1. **Module._resolveFilename blocked** — file-based `import()` specifiers (e.g., `import('/tmp/evil.js')`) are intercepted at the CJS module resolution level and blocked
2. **ESM loader hooks** — `module.registerHooks()` (Node.js 23.5+) or `module.register()` (Node.js 20.6+) installs hooks that reject `data:` and `blob:` URL specifiers process-wide. No CLI flags required.
3. **Filesystem restrictions** — OverlayFs writes to memory only, InMemoryFs has no real FS backing, so attacker cannot write .js files to the real filesystem
4. **Architecture** — no code path exists from bash interpretation to JS execution; all paths (Function, eval, setTimeout, constructor chains) are blocked

**Residual risk**: On Node.js < 20.6 where `module.register()` is unavailable, `data:` URL imports remain unblockable. For those deployments, use `--experimental-loader` CLI hooks as an additional layer.

**Note**: The ESM loader hooks are process-wide and permanent (cannot be unregistered). This is an accepted trade-off — `data:` and `blob:` URL imports are essentially never used in production Node.js applications.

### 4.2 Pre-Captured References Bypass Defense-in-Depth

**Risk**: LOW (defense-in-depth is secondary)

If any code captures a reference to `Function`, `eval`, etc. **before** the defense-in-depth box is activated, that reference bypasses the proxy. This is documented and tested.

**Mitigation**: Defense-in-depth is a secondary layer. The primary defense is that no code path exists from bash interpretation to JavaScript execution.

### 4.3 globalThis Property Reassignment

**Risk**: LOW (defense-in-depth is secondary)

Attackers within the sandbox could overwrite `globalThis.Function` or use `Object.defineProperty` to replace blocking proxies. This is documented and tested.

**Mitigation**: Same as §4.2 — relies on no code path existing, not on the monkey-patching being unbypassable.

### 4.4 Signal/Job Control Not Fully Modeled

**Risk**: LOW

Bash `trap` command has limited security testing. Background job control (`&`, `fg`, `bg`) not systematically tested.

**Mitigation**: @ag-bash/bash doesn't spawn real processes, so signals/jobs operate within the virtual model only.

### 4.5 Unicode/Encoding Edge Cases

**Risk**: LOW

No systematic testing for invalid UTF-8, homograph attacks, or RTL override characters. These are display/confusion attacks, not execution escape vectors.

### 4.6 File Descriptor Manipulation

**Risk**: LOW (mitigated)

FD exhaustion is now enforced: `checkFdLimit()` is called before every `fileDescriptors.set()` across interpreter.ts, redirections.ts, and subshell-group.ts, enforcing `maxFileDescriptors` (default: 1024). No tests for `/dev/fd/` access — the virtual filesystem doesn't implement `/dev/fd/`.

### 4.7 Python Execution Surface (When Enabled)

**Risk**: MEDIUM (intentional, opt-in, isolation by construction)

> **Scope**: this section describes the **`python3` builtin only**
> (`src/commands/python3/`). It does **not** describe `ag-convert`, which spawns
> host `python3` via `child_process` and is subject to none of the restrictions
> below — see TB8 and §4.11.

When `python: true`, CPython 3.13 Emscripten provides full Python execution via WASM. Unlike the previous Pyodide-based approach, CPython Emscripten has zero JS bridge code — `import js` fails with `ModuleNotFoundError` because the module simply doesn't exist in the binary. No Python-level sandbox is needed; isolation is by construction.

**Build-time restrictions** (capabilities removed from binary):
- No `-sMAIN_MODULE`: dynamic linking disabled, `dlopen` fails with "dynamic linking not enabled"
- No `-lnodefs.js`, `-lidbfs.js`, `-lproxyfs.js`, `-lworkerfs.js`: no host FS mount types available
- No `_ctypes` C extension: `import ctypes` fails with `ImportError`
- No `_emscripten_run_script`: JS eval not callable from WASM
- `__emscripten_system` patched to return -1 (no `child_process.spawnSync`)
- Test modules (`_testcapi`, `_testinternalcapi`, etc.) stripped from binary

**Runtime mitigations**:
- Disabled by default; must be explicitly enabled via `{ python: true }`
- 30-second timeout (`maxPythonTimeoutMs`; configurable)
- Fresh Worker thread per execution (EXIT_RUNTIME; no state leakage between runs)
- `WorkerDefenseInDepth` with only 2 exclusions: `shared_array_buffer`, `atomics`
- Stdlib shipped as `.pyc`-only zip in MEMFS (no real FS access, no runtime compilation)
- 18+ file operations (open, stat, glob, pathlib, shutil, etc.) redirected through `/host` mount
- C-level file operations (`_io.open`) also confined by Emscripten VFS (no NODEFS/NODERAWFS)
- HTTP bridge via custom HTTPFS mount at `/_jb_http` (requires `secureFetch` allow-list)
- Environment variables explicitly passed (no host `process.env` leakage)
- Raw TCP/UDP sockets blocked by Emscripten ("Host is unreachable")
- `os.system()` returns -1, `subprocess`/`os.popen()` raise `OSError`

**Accepted behaviors** (not vulnerabilities):
- Python's `eval()` and `exec()` execute arbitrary Python (same as bash `eval`; no JS escalation path)
- `/lib` (MEMFS stdlib) is writable within a single execution (each execution is fresh)
- Symlink targets are readable via `os.readlink()` but not followable outside root
- Python can allocate memory up to WASM limits (mitigated by 30s timeout)

### 4.8 Error Message Information Leakage

**Risk**: LOW (mitigated)

Error sanitization is now systematic: `sanitizeError()` in FS layers (OverlayFs, ReadWriteFs) strips `.path` from `ErrnoException` objects, and `sanitizeErrorMessage()` strips OS paths, Node.js internal module paths (`node:internal/...`), and stack traces from raw error messages at all major choke points (builtin-dispatch catch-all, `Bash.exec()` error handlers including SecurityViolationError and ExecutionLimitError, CLI error outputs, Python FS bridge). Remaining risk is limited to custom commands that catch and re-format errors without using the sanitization function.

### 4.9 Heredoc Expansion Interaction

**Risk**: LOW

Heredocs with variable expansion are size-limited (10MB) but nested heredocs with complex expansion haven't been exhaustively fuzzed.

### 4.10 Reflect Object Frozen But Available

**Risk**: LOW

`Reflect` is frozen (not blocked) in the defense-in-depth layer. `Reflect.construct`, `Reflect.apply` etc. remain callable but cannot construct `Function` directly because the `Function` constructor itself is blocked.

### 4.11 Host Process Spawning via `ag-convert`

**Risk**: HIGH when a host directory is mounted (default-on command, host
execution, inherited environment) — **not** opt-in in 6.1

`ag-convert` is registered by default and calls
`spawnSync("python3", …, { env: { ...process.env } })`
(`src/commands/ag-convert/ag-convert.ts:205-209`). An untrusted script can invoke
it. Full detail, evidence, and the one control that *is* enforced (fail-closed
`toRealPath()` translation) are in **TB8**; this entry exists so the gap appears
in the gaps list rather than only in the boundary list.

Reachability is bounded by the fail-closed path translation: the argument must
resolve to a real host path, so with `InMemoryFs` (the default) every invocation
is refused. The exposure is real only for embedders using `OverlayFs` /
`ReadWriteFs` / `MountableFs` with a host-backed mount — for those, the converter
runs as an unconfined host process over the mounted tree.

**Mitigation**: see TB8. **Planned for 7.0**: `runtimes.hostPython` opt-in,
explicit minimal environment, wall-clock timeout.

### 4.12 Plan Mode Is Not a Confinement Mechanism

**Risk**: HIGH if relied upon as a boundary; LOW if treated as a UX affordance

Plan mode blocks command-layer writes but not shell redirections. Full detail and
the reproduction are in **TB7**. Listed here because "plan mode" reads like a
sandbox mode and previous revisions of this document described it as one.

**Mitigation**: use a read-only VFS (TB2), which *is* enforced. **Planned for
7.0**: a single write choke point that redirections also traverse.

---

## 5. Defense Layer Summary

| Layer | Type | Scope | Bypass Difficulty |
|-------|------|-------|-------------------|
| **Architecture** (no bash → JavaScript path) | Primary | JS code execution | Very High — no code path exists from bash to `eval`/`Function`/`import()` |
| **Filesystem** (OverlayFs/InMemoryFs) | Primary | File access | High — central gate functions (`resolveCanonicalPath`) |
| **Symlink blocking** (default-deny) | Primary | Path traversal | High — zero-extra-I/O validation via path comparison |
| **Network allow-list** | Primary | Network access | High — default-off, per-redirect validation |
| **Command registry** | Primary | Command execution | High — only registered JS implementations run |
| **Execution limits** | Primary | DoS | High — enforced at every loop/call/expansion |
| **Prototype pollution guards** | Primary | Data integrity | Medium — requires discipline across all new code |
| **Parser limits** | Primary | Parser DoS | High — token/depth/size/iteration limits |
| **re2js regex engine** | Primary | ReDoS | High — linear-time guarantee (no backtracking) |
| **Defense-in-depth** (globals) | Secondary | JS escape | Medium — monkey-patching has inherent limits |
| **Virtual process info** | Secondary | Info disclosure | High — no real values exposed |
| **Error sanitization** | Secondary | Info disclosure | High — systematic at FS layers + all error choke points + node:internal paths |
| **Plan mode** (TB7) | ~~Secondary~~ **NOT A LAYER in 6.1** | — | **Trivial — `echo x > file` bypasses it.** Enforced in 7.0 |
| **No host child process** (TB8 / §4.11) | ~~Primary~~ **NOT A LAYER in 6.1** | — | **None — `ag-convert` spawns host `python3` and is default-on.** Opt-in in 7.0 |

> The last two rows are deliberately kept in this table rather than deleted. A
> reader comparing 6.1 against an older revision of this document needs to see
> that these were *claimed* and are *not delivered*, not find the claim silently
> gone.

---

## 6. Threat Scenarios & Verdicts

| # | Scenario | Path | Verdict |
|---|----------|------|---------|
| 1 | Read /etc/passwd | `cat /etc/passwd` → OverlayFs → not under root → ENOENT | **BLOCKED** (primary FS) |
| 2 | Symlink escape | `ln -s /etc/passwd x` → allowSymlinks=false → EPERM | **BLOCKED** (symlink policy) |
| 3 | Access process.env | No bash→JS path. If bug: defense-in-depth → throw | **BLOCKED** (arch + secondary) |
| 4 | Infinite loop | `while true; do :; done` → maxLoopIterations → throw | **BLOCKED** (limits) |
| 5 | Prototype pollution | `arr[__proto__]=evil` → Map/null-prototype → no effect | **BLOCKED** (data guards) |
| 6 | dynamic import() escape | Hypothetical JS exec → `import('data:...')` → ESM hooks block data:/blob: URLs | **BLOCKED** (Node.js 20.6+; residual on older) |
| 7 | Network exfiltration | `curl evil.com` → network off → curl not registered | **BLOCKED** (network isolation) |
| 8 | process.exit() | No bash→JS path. If bug: defense-in-depth → throw | **BLOCKED** (arch + secondary) |
| 9 | Brace expansion OOM | `{1..999999999}` → maxBraceExpansionResults → truncated | **BLOCKED** (limits) |
| 10 | Python escape | Python off by default. If on: worker + defense + virtual FS | **RESIDUAL RISK** (opt-in) |
| 11 | ReDoS via user regex | `[[ str =~ evil_pattern ]]` → re2js → linear-time match | **BLOCKED** (re2js) |
| 12 | Path traversal | `cat ../../etc/shadow` → normalize → `isPathWithinRoot()` → ENOENT | **BLOCKED** (primary FS) |
| 13 | Null byte injection | `cat "file\x00../../etc/passwd"` → `validatePath()` → rejected | **BLOCKED** (path validation) |
| 14 | Error path leak | FS error with real path → `sanitizeError()` → path stripped | **BLOCKED** (error sanitization) |
| 15 | Constructor chain | `({}).constructor.constructor('code')()` → constructor patched → throw | **BLOCKED** (defense-in-depth) |
| 16 | Source depth bomb | Self-sourcing `source /s.sh` → maxSourceDepth (100) → throw | **BLOCKED** (limits) |
| 17 | FD exhaustion | `exec N>/dev/null` loop → checkFdLimit → maxFileDescriptors (1024) → throw | **BLOCKED** (limits) |
| 18 | Glob `**` depth | `**/**/**/**/**/**/x` → MAX_GLOBSTAR_SEGMENTS (5) → throw | **BLOCKED** (limits) |
| 20 | performance.now() timing | Sub-ms timing attack → blocked by defense-in-depth | **BLOCKED** (secondary) |
| 21 | Prototype pollution via `__defineGetter__` | Inject getter on prototype → blocked by defense-in-depth | **BLOCKED** (secondary) |
| 22 | File-based import() | `import('/tmp/evil.js')` → Module._resolveFilename blocked → throw | **BLOCKED** (secondary) |
| 23 | data: URL import() | `import('data:text/javascript,...')` → ESM loader hooks → throw | **BLOCKED** (Node.js 20.6+) |
| 24 | Plan-mode write via builtin | `touch /a.txt` in plan mode → `defense-aware-command-context` → SecurityViolationError | **BLOCKED** (command layer only; see 25) |
| 25 | **Plan-mode write via redirection** | `echo pwned > /b.txt` in plan mode → `applyRedirections(ctx)` → raw `ctx.fs.writeFile` | **NOT BLOCKED** — exit 0, file written (TB7). Enforced in 7.0 |
| 26 | Plan-mode write, defense-in-depth off | `{ security: { defenseInDepth: false } }` + `touch /c.txt` → guard not installed | **NOT BLOCKED** (TB7) |
| 27 | **Host `python3` via ag-convert** | `ag-convert <mounted-file>` → `spawnSync("python3", …, { env: {...process.env} })` | **NOT SANDBOXED** — runs on the host with the parent environment (TB8). Opt-in in 7.0 |
| 28 | ag-convert on a VFS-only path | `ag-convert /etc/passwd` (in-memory) → `toRealPath()` returns null → refuse | **BLOCKED** (fail-closed translation; `ag-convert.hostpath.test.ts`) |

---

## 7. Recommendations for Future Hardening

### Committed for 7.0 (the two false claims above)

- **P0 — Make plan mode a real boundary (TB7).** Route every filesystem write
  through one choke point that `applyRedirections()` also traverses, so
  `echo x > f`, `: > f`, `>>`, and `&>` are subject to the same mode check as
  `touch`. Decouple that check from `defenseInDepth` / `IS_BROWSER` so it holds in
  browser builds too. Then either wire `PermissionManager.checkPermission()` into
  the choke point or delete `PermissionManager` — shipping an unreferenced
  permission engine is how this claim survived four minor versions.
- **P0 — Put `ag-convert`'s host `python3` behind `runtimes.hostPython` (TB8).**
  Default off. Replace `env: { ...process.env }` with an explicit minimal
  environment. Add a wall-clock timeout. Require an explicit second opt-in for
  `--setup` (it network-installs unpinned packages into the host Python).
- **P1 — Add a doc/code drift gate.** Both of these claims were false in shipped
  documentation across several releases. A `Status:` line that no test asserts is
  the same failure mode one level up.

### Longer-term

1. ~~**`--experimental-loader` for import() blocking**~~ — **IMPLEMENTED**: ESM loader hooks via `module.register()` (Node.js 20.6+) / `module.registerHooks()` (Node.js 23.5+) block `data:` and `blob:` URL imports process-wide. Combined with `Module._resolveFilename` blocking for file specifiers, `import()` is fully mitigated on Node.js 20.6+. No CLI flags required.
2. ~~**Systematic error message audit**~~ — **IMPLEMENTED**: `sanitizeErrorMessage()` applied at all error choke points; strips OS paths, `node:internal/` paths, and stack traces
3. **Content Security Policy for output** — Consider sanitizing output to prevent XSS when sandbox output is rendered in web contexts
4. **Expand fuzzing corpus** — Add grammar rules for trap, job control (`&`, `fg`, `bg`), and deeply nested heredocs with expansion
5. **Total memory ceiling** — Track total memory allocated per `exec()` call to provide a hard memory ceiling (not just per-object limits)
6. ~~**process.connected / process.send / process.channel**~~ — **IMPLEMENTED**: Blocked via defense-in-depth (proxy for send/channel, defineProperty for connected)
7. ~~**process.chdir**~~ — **IMPLEMENTED**: Blocked via defense-in-depth proxy
8. ~~**import() expression blocking**~~ — **IMPLEMENTED**: `Module._resolveFilename` blocked by defense-in-depth proxy (data: URLs still bypass)
9. ~~**source/. depth limit**~~ — **IMPLEMENTED**: maxSourceDepth (100) enforced in `handleSource()`
10. ~~**process.stdout/stderr blocking**~~ — **IMPLEMENTED**: Blocked via defense-in-depth in worker contexts; skipped in main thread (console.log dependency)
11. ~~**performance.now() blocking**~~ — **IMPLEMENTED**: Blocked via defense-in-depth; internal uses pre-captured `_performanceNow`
12. ~~**Stack trace sanitization**~~ — **IMPLEMENTED**: `sanitizeErrorMessage()` applied to SecurityViolationError and ExecutionLimitError in `Bash.exec()`; `node:internal/` paths stripped
13. ~~**FD exhaustion enforcement**~~ — **IMPLEMENTED**: `checkFdLimit()` before every `fileDescriptors.set()` across interpreter, redirections, subshell-group
14. ~~**Glob pattern depth limit**~~ — **IMPLEMENTED**: MAX_GLOBSTAR_SEGMENTS (5) rejects patterns with excessive `**` segments
15. ~~**Intl/TextDecoder/TextEncoder audit**~~ — **ACCEPTED RISK**: Used by 40+ internal files; no escape vectors; documented in blocked-globals.ts
16. ~~**Frozen builtins**~~ — **IMPLEMENTED**: `__defineGetter__`/`__defineSetter__`/`__lookupGetter__`/`__lookupSetter__` blocked; JSON and Math frozen
