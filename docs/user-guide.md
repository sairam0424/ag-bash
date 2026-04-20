# Ag-Bash User Guide: The Agentic Shell

Welcome to **Ag-Bash**, the industry-standard secure runtime designed specifically for AI agents and high-fidelity virtual environments. This guide walks you through the core concepts, installation, and advanced workflows of the Ag-Bash ecosystem.

---

## 🚀 Getting Started

Ag-Bash is not just a terminal; it is a **Secure Unified Agentic Runtime**. It allows you to run Bash, Python, and JavaScript in a single, byte-transparent virtualized environment.

### 1. Installation

Ag-Bash is typically used as a dependency in monorepos or as a standalone CLI.

```bash
# Clone and Setup
git clone https://github.com/sairam0424/ag-bash.git
cd ag-bash
pnpm install
pnpm build
```

### 2. Launching the Interactive Shell

The `ag-shell` is your playground for human-in-the-loop debugging.

```bash
cd packages/bash
pnpm shell
```

---

## 🏗️ Core Architecture

Ag-Bash operates on three foundational pillars:

### 📁 OverlayFS (The Mirror Filesystem)
Ag-Bash uses a **Copy-on-Write (CoW)** filesystem. 
- **Read**: It mirrors your local project files exactly.
- **Write**: All modifications stay in a virtual memory layer. 
- **Benefit**: Your real codebase is never accidentally deleted by an agent, but the agent *thinks* it is working on real files.

### 🧠 Agentic Healer
When a command fails, Ag-Bash doesn't just error out. It performs a semantic analysis of the failure and provides **LLM-ready observations**.
- Detects typos in variables.
- Suggests missing packages.
- Provides "Did you mean?" suggestions for commands and file paths.

### 🛡️ Defense-in-Depth
Ag-Bash implements absolute isolation using WASM runtimes. Even if an agent tries to run malicious code, it is trapped within the virtual machine.

---

## 💡 Pro Workflows

### The "Synergy" Pipeline
Combine different runtimes in a single pipeline.

```bash
# Scrape HTML, convert to Markdown, process with Python, filter with JQ
curl -s https://example.com | \
html-to-markdown | \
python3 -c "import sys; print(sys.stdin.read().upper())" | \
jq -R '.'
```

### Database Experimentation
Test high-performance SQL queries without setting up a DB server.

```bash
echo "CREATE TABLE logs (msg TEXT); INSERT INTO logs VALUES ('Agent started'); SELECT * FROM logs;" | sqlite3 :memory:
```

---

## 📚 Reference Links
- [Command Registry](./COMMAND_REGISTRY.md) - Full list of supported tools.
- [Data Intel Registry](./registry/data_intel.md) - Deep dive into SQL, JQ, and XAN.
- [Runtimes Guide](./registry/agentic_runtimes.md) - Master Python and JS integration.
