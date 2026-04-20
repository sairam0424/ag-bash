# 📖 Ag-Bash Command Registry

This registry provides a categorized index of the **100+ commands** supported by Ag-Bash. All commands are virtualized, sandboxed, and statically analyzable.

---

## 📁 Core Operations & Filesystem
*Standard POSIX-compliant tools for file management and navigation.*

| Command | Description | Registry Link |
| :--- | :--- | :--- |
| `ls` | List directory contents with high-fidelity formatting. | [View Details](./registry/core_io.md) |
| `cd` / `pwd` | Change and print working directory. | [View Details](./registry/core_io.md) |
| `mkdir` / `rmdir` | Directory creation and removal. | [View Details](./registry/core_io.md) |
| `cp` / `mv` / `rm` | File copying, moving, and deletion. | [View Details](./registry/core_io.md) |
| `chmod` / `stat` | Permission management and file metadata. | [View Details](./registry/core_io.md) |

---

## 🧠 Data Intelligence
*Advanced structured data processing tools running natively in WASM.*

| Command | Category | Best For | Registry Link |
| :--- | :--- | :--- | :--- |
| `jq` | JSON | Stream processing and filtering. | [Data Intel](./registry/data_intel.md) |
| `yq` | YAML | Multi-document processing. | [Data Intel](./registry/data_intel.md) |
| `sqlite3` | SQL | In-memory relational logic. | [Data Intel](./registry/data_intel.md) |
| `xan` | CSV/TSV | High-performance tabular data manipulation. | [Data Intel](./registry/data_intel.md) |
| `html-to-markdown` | Web | Transforming web content for LLM RAG. | [Data Intel](./registry/data_intel.md) |

---

## 🤖 Agentic Runtimes
*Sandbox isolation for arbitrary code execution.*

| Command | Runtime | Description | Registry Link |
| :--- | :--- | :--- | :--- |
| `python3` | CPython (WASM) | Complete Python 3.11 environment. | [Agentic Guide](./registry/agentic_runtimes.md) |
| `js-exec` | QuickJS | Lightweight, extremely fast JavaScript logic. | [Agentic Guide](./registry/agentic_runtimes.md) |
| `awk` / `sed` | POSIX | Traditional stream editing and reporting. | [Agentic Guide](./registry/agentic_runtimes.md) |

---

## 🔒 Security & Proof
*Tools for cryptographic verification and auditing.*

| Command | Use Case |
| :--- | :--- |
| `sha256sum` | Verify file integrity with high-entropy hashing. |
| `md5sum` | Legacy checksum verification. |
| `base64` | Binary-to-text encoding for payload transport. |

---

## 🌐 External Integration
*Bridging the virtual sandbox with the outside world.*

| Command | Use Case |
| :--- | :--- |
| `git` | Perform version control operations within the OverlayFS. |
| `curl` | Audited network requests (Isolated via proxy). |
| `rg` (ripgrep) | Ultra-fast semantic code search. |

---

## 💡 Pro Tip: Command Discovery
Run `help` or `ag-bash --help` inside the shell to see the dynamic list of commands available in your current permission scope.
