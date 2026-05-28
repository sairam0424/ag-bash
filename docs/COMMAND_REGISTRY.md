# Ag-Bash Command Registry (v5.0.0)

This registry provides a categorized index of the **150+ commands** supported by Ag-Bash. All commands are virtualized, sandboxed, and optimized for Project V-Next.

---

## Core Operations & Filesystem

*Standard POSIX-compliant tools for file management and navigation.*

| Command | Description | Registry Link |
| :--- | :--- | :--- |
| `ls` | List directory contents with high-fidelity formatting. | [View Details](./registry/core_io.md) |
| `cd` / `pwd` | Change and print working directory. | [View Details](./registry/core_io.md) |
| `mkdir` / `rmdir` | Directory creation and removal. | [View Details](./registry/core_io.md) |
| `cp` / `mv` / `rm` | File copying, moving, and deletion. | [View Details](./registry/core_io.md) |
| `chmod` / `stat` | Permission management and file metadata. | [View Details](./registry/core_io.md) |
| `ln` / `readlink` | Symbolic and hard link management. | [View Details](./registry/core_io.md) |
| `touch` / `file` | File creation and type detection. | [View Details](./registry/core_io.md) |
| `tree` / `du` | Directory tree visualization and disk usage. | [View Details](./registry/core_io.md) |
| `find` | Recursive file search with filter predicates. | [View Details](./registry/core_io.md) |
| `tar` / `gzip` | Archive and compression utilities. | [View Details](./registry/core_io.md) |

---

## Data Intelligence

*Advanced structured data processing tools running natively in WASM.*

| Command | Category | Best For | Registry Link |
| :--- | :--- | :--- | :--- |
| `jq` | JSON | Stream processing and filtering. | [Data Intel](./registry/data_intel.md) |
| `yq` | YAML | Multi-document processing. | [Data Intel](./registry/data_intel.md) |
| `sqlite3` | SQL | In-memory relational logic. | [Data Intel](./registry/data_intel.md) |
| `xan` | CSV/TSV | High-performance tabular data manipulation. | [Data Intel](./registry/data_intel.md) |
| `html-to-markdown` | Web | Transforming web content for LLM RAG. | [Data Intel](./registry/data_intel.md) |

---

## Agentic Runtimes

*Sandbox isolation for arbitrary code execution.*

| Command | Runtime | Description | Registry Link |
| :--- | :--- | :--- | :--- |
| `python3` | CPython (WASM) | Complete Python 3.11 environment. | [Agentic Guide](./registry/agentic_runtimes.md) |
| `js-exec` | QuickJS | Lightweight, extremely fast JavaScript logic. | [Agentic Guide](./registry/agentic_runtimes.md) |
| `awk` / `sed` | POSIX | Traditional stream editing and reporting. | [Agentic Guide](./registry/agentic_runtimes.md) |

---

## Nexus Suite

*AI-native surgical editing, analysis, and code intelligence tools.*

| Command | Runtime | Description | Registry Link |
| :--- | :--- | :--- | :--- |
| `ag-edit` | Nexus | Atomic, line-based file editing for autonomous agents. | [Nexus Upgrades](./registry/nexus.md) |
| `ag-diff` | Nexus | Semantic diff engine with LLM-optimized summaries. | [Nexus Upgrades](./registry/nexus.md) |
| `ag-snapshot` | Nexus | Persistent environment state and filesystem checkpointing. | [Nexus Upgrades](./registry/nexus.md) |
| `ag-analyze` | Nexus | Structural script analysis and symbol extraction. | [Nexus Upgrades](./registry/nexus.md) |
| `ag-hover` | Nexus Prime | Retrieve metadata and documentation for a specific symbol. | [Nexus Upgrades](./registry/nexus.md) |
| `ag-explain` | Nexus Prime | Parse and explain the structure of complex shell commands. | [Nexus Upgrades](./registry/nexus.md) |
| `ag-find-symbol` | Nexus Prime | Global search for symbol definitions and references. | [Nexus Upgrades](./registry/nexus.md) |
| `ag-references` | Nexus Prime | Find all references to a symbol across the workspace. | [Nexus Upgrades](./registry/nexus.md) |
| `ag-todo` | Nexus Prime | Persistent local task management for agent tracking. | [Nexus Upgrades](./registry/nexus.md) |

---

## Agentic Tools

*Plan-mode, document conversion, search, and notebook management.*

| Command | Runtime | Description | Registry Link |
| :--- | :--- | :--- | :--- |
| `ag-plan` | Nexus | Plan-mode orchestration: enter/exit read-only mode and manage multi-step plans. | [Agentic Tools](./registry/agentic_tools.md) |
| `ag-notebook` | Nexus | Read, edit, and append cells in Jupyter Notebook (.ipynb) files. | [Agentic Tools](./registry/agentic_tools.md) |
| `ag-convert` | Hyperion | Intelligent document and image-to-markdown conversion with AI vision. | [Agentic Tools](./registry/agentic_tools.md) |
| `ag-grep` | Nexus | High-performance recursive pattern search across the virtual filesystem. | [Agentic Tools](./registry/agentic_tools.md) |
| `ag-find-files` | Nexus | High-performance recursive file search by name pattern. | [Agentic Tools](./registry/agentic_tools.md) |
| `ag-glob` | Nexus | Fast glob pattern matching over the virtual filesystem. | [Agentic Tools](./registry/agentic_tools.md) |
| `ag-worktree` | Nexus | Manage isolated virtual worktrees for parallel development. | [Agentic Tools](./registry/agentic_tools.md) |

---

## MCP & Orchestration

*Model Context Protocol integration and multi-agent coordination.*

| Command | Runtime | Description | Registry Link |
| :--- | :--- | :--- | :--- |
| `ag-mcp` | Nexus | Connect to MCP servers, list tools, and invoke remote tool calls. | [MCP & Orchestration](./registry/mcp_orchestration.md) |
| `ag-spawn` | Nexus | Start a sub-agent in the background with a given command. | [MCP & Orchestration](./registry/mcp_orchestration.md) |
| `ag-wait` | Nexus | Synchronize with and collect output from a sub-agent. | [MCP & Orchestration](./registry/mcp_orchestration.md) |
| `ag-list-agents` | Nexus | List all active sub-agents and their statuses. | [MCP & Orchestration](./registry/mcp_orchestration.md) |
| `ag-task` | Nexus | Manage background tasks with lifecycle tracking (create, update, stop). | [MCP & Orchestration](./registry/mcp_orchestration.md) |
| `ag-team` | Nexus | Manage multi-agent teams (create, add/remove agents, list). | [MCP & Orchestration](./registry/mcp_orchestration.md) |
| `ag-message` | Nexus | Inter-agent messaging: send, broadcast, and read inbox. | [MCP & Orchestration](./registry/mcp_orchestration.md) |
| `ag-cron` | Nexus | Manage scheduled cron jobs with standard 5-field expressions. | [MCP & Orchestration](./registry/mcp_orchestration.md) |
| `ag-web-fetch` | Toolbox | Fetch a web page and convert content to clean markdown (cached). | [MCP & Orchestration](./registry/mcp_orchestration.md) |
| `ag-web-search` | Toolbox | Search the web for current information and documentation. | [MCP & Orchestration](./registry/mcp_orchestration.md) |

---

## Security & Proof

*Tools for cryptographic verification and auditing.*

| Command | Use Case |
| :--- | :--- |
| `sha256sum` | Verify file integrity with high-entropy hashing. |
| `sha1sum` | SHA-1 checksum generation and verification. |
| `md5sum` | Legacy checksum verification. |
| `base64` | Binary-to-text encoding for payload transport. |

---

## External Integration

*Bridging the virtual sandbox with the outside world.*

| Command | Use Case |
| :--- | :--- |
| `git` | Perform version control operations within the OverlayFS. |
| `curl` | Audited network requests (isolated via proxy). |
| `rg` (ripgrep) | Ultra-fast semantic code search. |

---

## Text Processing

*Stream editing, filtering, and transformation utilities.*

| Command | Use Case |
| :--- | :--- |
| `grep` / `fgrep` / `egrep` | Pattern matching with basic, fixed, and extended regex. |
| `sort` / `uniq` | Sorting and deduplication. |
| `cut` / `paste` / `join` | Column extraction, merging, and relational joins. |
| `tr` / `rev` / `fold` | Character translation, reversal, and line wrapping. |
| `nl` / `expand` / `column` | Line numbering, tab expansion, and table formatting. |
| `tee` / `tac` / `od` | Tee output, reverse line order, and octal dump. |
| `diff` | File comparison with unified diff output. |
| `strings` / `split` | Binary string extraction and file splitting. |
| `head` / `tail` / `wc` | Viewing file heads/tails and counting lines/words/bytes. |

---

## Shell Builtins

*Interpreter-level commands handled directly by the execution engine.*

| Command | Use Case |
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

## Discoverability & Diagnostics

*Commands for exploring the shell's capabilities and verifying setup health (v5.0.0).*

| Command | Description | Registry Link |
| :--- | :--- | :--- |
| `commands` | List all available commands with categories and search. | [Discoverability](./registry/discoverability.md) |
| `about` | Show ag-bash features, architecture, and version. | [Discoverability](./registry/discoverability.md) |
| `doctor` | Run environment health checks and verify setup. | [Discoverability](./registry/discoverability.md) |

---

## Pro Tip: Command Discovery

Run `commands` to browse the full registry, or `commands --search <keyword>` to filter by name or description. Use `doctor` to verify your environment is correctly configured.
