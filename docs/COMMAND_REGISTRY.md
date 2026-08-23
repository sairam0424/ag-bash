# Ag-Bash Command Registry

This registry provides a categorized index of the commands supported by Ag-Bash. Commands run against the virtual filesystem and are optimized for Project V-Next — **with two documented exceptions that are not sandboxed as the rest are. See [Security caveats on specific commands](#security-caveats-on-specific-commands) before assuming a command is confined.**

**How to read this file.** Everything between the `BEGIN GENERATED` / `END GENERATED` markers is produced from the command registry by `scripts/gen-command-registry.mjs` and must not be hand-edited; the sections after the closing marker are hand-authored. `packages/bash/src/commands/registry.doc.test.ts` fails if the generated inventory and the registry disagree in either direction, which is what keeps this document from drifting the way it did through v5.0.0.

---

<!-- BEGIN GENERATED: command-inventory -->
This inventory is generated from `packages/bash/src/commands/definitions/` by
`scripts/gen-command-registry.mjs`. Do not hand-edit between the markers —
run `node scripts/gen-command-registry.mjs` instead.

**117 commands** are registered: 112 always-on builtins, 1 gated on network access, 2 on the Python (WASM) runtime, and 2 on the JavaScript (WASM) runtime.

---

## Basic I/O

*Reading and writing streams — the primitives everything else composes.*

| Command | Description |
| :--- | :--- |
| `cat` | Concatenate files to standard output. |
| `echo` | Write arguments to standard output. |
| `printf` | Format and print data with printf(3) conversions. |

---

## Core Operations & Filesystem

*Standard POSIX-compliant tools for file management and navigation. See [details](./registry/core_io.md).*

| Command | Description |
| :--- | :--- |
| `ls` | List directory contents with high-fidelity formatting. |
| `pwd` | Print the current working directory. |
| `mkdir` | Create directories. |
| `rmdir` | Remove empty directories. |
| `cp` | Copy files and directories. |
| `mv` | Move and rename files and directories. |
| `rm` | Delete files and directories. |
| `chmod` | Change file permission bits. |
| `stat` | Report file metadata. |
| `ln` | Create symbolic and hard links. |
| `readlink` | Resolve the target of a symbolic link. |
| `touch` | Create files and update timestamps. |
| `file` | Detect file type from content. |
| `basename` | Strip directory and suffix from a path. |
| `dirname` | Strip the last component from a path. |
| `tree` | Visualize a directory tree. |
| `du` | Report disk usage. |
| `find` | Recursive file search with filter predicates. |
| `tar` | Create and extract tar archives. |
| `gzip` | Compress files with gzip. |
| `gunzip` | Decompress gzip archives. |
| `zcat` | Stream the decompressed contents of a gzip file. |

---

## Text Processing

*Stream editing, filtering, and transformation utilities.*

| Command | Description |
| :--- | :--- |
| `grep` | Pattern matching with basic regular expressions. |
| `fgrep` | Pattern matching with fixed strings. |
| `egrep` | Pattern matching with extended regular expressions. |
| `rg` | Ultra-fast recursive code search (ripgrep). |
| `sed` | Stream editing with substitution and scripting. |
| `awk` | Pattern-action text processing and reporting. |
| `sort` | Sort lines of text. |
| `uniq` | Report or filter repeated lines. |
| `comm` | Compare two sorted files line by line. |
| `cut` | Extract columns from each line. |
| `paste` | Merge lines of files side by side. |
| `join` | Relational join on a common field. |
| `tr` | Translate or delete characters. |
| `rev` | Reverse the characters on each line. |
| `fold` | Wrap lines to a fixed width. |
| `nl` | Number the lines of output. |
| `expand` | Convert tabs to spaces. |
| `unexpand` | Convert spaces to tabs. |
| `column` | Format input into aligned columns. |
| `tee` | Copy standard input to files and standard output. |
| `tac` | Print lines in reverse order. |
| `od` | Dump files in octal and other formats. |
| `head` | Print the first lines of a file. |
| `tail` | Print the last lines of a file. |
| `wc` | Count lines, words, and bytes. |
| `diff` | File comparison with unified diff output. |
| `strings` | Extract printable strings from binary data. |
| `split` | Split a file into pieces. |

---

## Data Intelligence

*Advanced structured data processing tools running natively in WASM. See [details](./registry/data_intel.md).*

| Command | Description |
| :--- | :--- |
| `jq` | JSON stream processing and filtering. |
| `yq` | YAML multi-document processing. |
| `sqlite3` | In-memory relational logic over SQL. |
| `xan` | High-performance CSV/TSV tabular data manipulation. |
| `html-to-markdown` | Transform web content to markdown for LLM retrieval. |

---

## Agentic Runtimes

*Sandbox isolation for arbitrary code execution. See [details](./registry/agentic_runtimes.md).*

| Command | Description |
| :--- | :--- |
| `python3` | Complete Python 3.11 environment (CPython on WASM). |
| `python` | Alias for `python3`. |
| `js-exec` | Lightweight, extremely fast JavaScript logic (QuickJS). |
| `node` | Stub that exits non-zero and redirects the caller to `js-exec`; there is no Node runtime in the sandbox. |

---

## Nexus Suite

*AI-native surgical editing, analysis, and code intelligence tools. See [details](./registry/nexus.md).*

| Command | Description |
| :--- | :--- |
| `ag-edit` | Atomic, line-based file editing for autonomous agents. |
| `ag-diff` | Semantic diff engine with LLM-optimized summaries. |
| `ag-snapshot` | Persistent environment state and filesystem checkpointing. |
| `ag-analyze` | Structural script analysis and symbol extraction. |
| `ag-hover` | Retrieve metadata and documentation for a specific symbol. |
| `ag-explain` | Parse and explain the structure of complex shell commands. |
| `ag-find-symbol` | Global search for symbol definitions and references. |
| `ag-references` | Find all references to a symbol across the workspace. |
| `ag-todo` | Persistent local task management for agent tracking. |

---

## Agentic Tools

*Plan-mode, document conversion, search, and notebook management. See [details](./registry/agentic_tools.md).*

| Command | Description |
| :--- | :--- |
| `ag-plan` | Plan-mode orchestration: enter/exit read-only mode and manage multi-step plans. |
| `ag-notebook` | Read, edit, and append cells in Jupyter Notebook (.ipynb) files. |
| `ag-convert` | Intelligent document and image-to-markdown conversion with AI vision. |
| `ag-grep` | High-performance recursive pattern search across the virtual filesystem. |
| `ag-find-files` | High-performance recursive file search by name pattern. |
| `ag-glob` | Fast glob pattern matching over the virtual filesystem. |
| `ag-worktree` | Manage isolated virtual worktrees for parallel development. |

---

## MCP & Orchestration

*Model Context Protocol integration and multi-agent coordination. See [details](./registry/mcp_orchestration.md).*

| Command | Description |
| :--- | :--- |
| `ag-mcp` | Connect to MCP servers, list tools, and invoke remote tool calls. |
| `ag-spawn` | Start a sub-agent in the background with a given command. |
| `ag-wait` | Synchronize with and collect output from a sub-agent. |
| `ag-list-agents` | List all active sub-agents and their statuses. |
| `ag-task` | Manage background tasks with lifecycle tracking (create, update, stop). |
| `ag-team` | Manage multi-agent teams (create, add/remove agents, list). |
| `ag-message` | Inter-agent messaging: send, broadcast, and read inbox. |
| `ag-cron` | Manage scheduled cron jobs with standard 5-field expressions. |

---

## Security & Proof

*Tools for cryptographic verification and auditing.*

| Command | Description |
| :--- | :--- |
| `sha256sum` | Verify file integrity with high-entropy hashing. |
| `sha1sum` | SHA-1 checksum generation and verification. |
| `md5sum` | Legacy checksum verification. |
| `base64` | Binary-to-text encoding for payload transport. |

---

## External Integration

*Bridging the virtual sandbox with the outside world.*

| Command | Description |
| :--- | :--- |
| `git` | Perform version control operations within the OverlayFS. |
| `curl` | Audited network requests (isolated via proxy). |

---

## Shell & Environment

*Nested shells, environment inspection, and small process utilities. These are registry commands; for interpreter-level builtins such as `export` or `[[`, see the hand-authored section below.*

| Command | Description |
| :--- | :--- |
| `bash` | Run a script or command string in a nested shell. |
| `sh` | POSIX shell entry point backed by the same nested shell. |
| `env` | Print the environment, or run a command with a modified one. |
| `printenv` | Print environment variable values. |
| `alias` | Define or list command aliases. |
| `unalias` | Remove command aliases. |
| `history` | List the command history. |
| `xargs` | Build and run command lines from standard input. |
| `which` | Locate a command on the search path. |
| `help` | Show usage for builtin commands. |
| `true` | Do nothing, successfully — exit status 0. |
| `false` | Do nothing, unsuccessfully — exit status 1. |
| `clear` | Clear the terminal screen. |
| `whoami` | Print the effective user name. |
| `hostname` | Print the sandbox host name. |
| `date` | Print or format the current date and time. |
| `sleep` | Delay for a specified duration. |
| `timeout` | Run a command with a wall-clock limit. |
| `time` | Measure the execution time of a command. |
| `seq` | Print a sequence of numbers. |
| `expr` | Evaluate an integer or string expression. |
| `hello` | Minimal smoke-test command that greets the caller. |

---

## Discoverability & Diagnostics

*Commands for exploring the shell's capabilities and verifying setup health.*

| Command | Description |
| :--- | :--- |
| `commands` | List all available commands with categories and search. |
| `about` | Show ag-bash features, architecture, and version. |
| `doctor` | Run environment health checks and verify setup. |
<!-- END GENERATED: command-inventory -->

---

## Security caveats on specific commands

*Hand-authored. The generated inventory above lists what each command **does**; it
carries no security metadata, so these two exceptions are recorded here. Both are
tracked in `THREAT_MODEL.md` and targeted for 7.0.*

| Command | Caveat |
| :--- | :--- |
| `ag-convert` | **Not WASM-sandboxed.** Spawns **host** `python3` via `spawnSync` with the full parent environment (`{ ...process.env }`), and is registered by default. This is a different path from the `python3` builtin, which *is* confined to the CPython Emscripten WASM sandbox. `ag-convert` fails closed on paths that exist only in the VFS, so exposure is limited to host directories the embedder deliberately mounted — but over those files it runs as an unconfined host process. See `THREAT_MODEL.md` TB8 and §4.11. |
| `ag-plan` | **Plan mode is not a security boundary.** `ag-plan enter` blocks destructive *commands* (`touch`, `rm`, `tee`, `ag-edit`), but a shell **redirection** bypasses it entirely — `echo x > file` succeeds with exit 0 in plan mode. Treat it as a guardrail against accidental edits, not as confinement. For a genuinely read-only session use `new OverlayFs({ root, readOnly: true })` — note `InMemoryFs` has no `readOnly` option and accepts writes. See `THREAT_MODEL.md` TB7. |

The MCP stdio client (`ag-mcp`) and the LSP integration also spawn host
processes, but only when the embedder configures a server — unlike `ag-convert`
they are not reachable from a bare `new Bash()`.

---

## Interpreter Builtins

*Hand-authored. These are handled directly by the execution engine rather than
dispatched through the command registry, so they are deliberately outside the
generated inventory above and do not appear in `commands --list`.*

| Builtin | Use Case |
| :--- | :--- |
| `export` / `declare` / `local` | Variable declaration and scoping. |
| `set` / `shopt` | Shell option configuration. |
| `source` / `eval` / `exec` | Script sourcing, evaluation, and process replacement. |
| `read` / `readarray` / `mapfile` | Interactive input and array population. |
| `test` / `[` / `[[` | Conditional expression evaluation. |
| `cd` / `pushd` / `popd` / `dirs` | Directory stack navigation. |
| `break` / `continue` / `return` / `exit` | Flow control. |
| `shift` / `getopts` | Positional parameter manipulation. |
| `trap` / `wait` | Signal handling and job synchronization. |
| `command` / `builtin` / `type` / `hash` | Command resolution and lookup. |
| `let` / `(( ))` | Arithmetic evaluation. |

---

## Agent Toolbox Tools

*Hand-authored, and **not** shell commands. These are `ToolboxTool` entries in
`packages/bash/src/agentic/toolbox/registry.ts`, surfaced to agents as tool calls;
they are not registered in the command registry and cannot be invoked from a
script. Revisions of this document through v5.0.0 listed them alongside real
commands, which was incorrect. The toolbox has no generator yet, so this table
is hand-maintained.*

| Tool | Use Case |
| :--- | :--- |
| `ag-web-fetch` | Fetch a web page and convert content to clean markdown (cached). |
| `ag-web-search` | Search the web for current information and documentation. |

---

## Pro Tip: Command Discovery

Run `commands` to browse the full registry, or `commands --search <keyword>` to filter by name or description. Use `doctor` to verify your environment is correctly configured.
