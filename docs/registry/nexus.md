# 🚀 Nexus & V-Next Agentic Suite

The **Nexus Agentic Suite** is a collection of high-fidelity tools designed to give autonomous agents surgical control over codebases and persistent environments.

---

## 🩹 Agentic Healer 2.0 (New in v2.4.0)

**Environment-aware automated remediation.**

The `AgenticHealer` is an internal intelligence loop that activates when shell commands fail. It uses the `BashToolbox` to discover relevant tools for fixing the error.

### Healer Capabilities

- **Semantic Discovery**: Automatically identifies tools like `ag-find-symbol` or `ag-analyze` when a "file not found" or "symbol missing" error occurs.
- **Smart Scoring**: Ranks potential fixes based on the error context and tool metadata.

---

## 📡 Tooling 2.0 Observability (New in v2.4.0)

**High-fidelity event streaming for host applications.**

The `Bash` class now emits structured events for every tool execution, enabling rich UI feedback and detailed audit logs.

### Tool Lifecycle Events

- `tool:start`: Triggered when an agent initiates a tool call.
- `tool:progress`: Real-time updates for long-running operations.
- `tool:end`: Final status, duration, and summary of the tool execution.

---

## 🧠 ag-hover (v2.0.0+)

**Contextual metadata for symbols.**

Retrieve documentation, type hints, and definitions for symbols at a specific file location.

### Usage: ag-hover

```bash
# Get documentation for the symbol at line 12, column 5
ag-hover src/main.ts 12 5
```

---

## 🗣️ ag-explain (v2.0.0+)

**AST-driven pipeline explanation.**

Uses the Tree-sitter engine to provide a human-readable (and agent-readable) breakdown of complex shell pipelines.

### Usage: ag-explain

```bash
# Explain a complex find + xargs + sed pipeline
ag-explain "find . -name '*.ts' | xargs grep 'todo' | sed 's/todo/FIXME/g'"
```

---

## 🔎 ag-find-symbol (v2.0.0+)

**Global symbol discovery.**

Performs high-speed workspace indexing to find definitions and references of any symbol across the VFS.

### Usage: ag-find-symbol

```bash
# Find all definitions of 'BaseInterpreter'
ag-find-symbol define BaseInterpreter

# Find all usages of 'SharedStateBus'
ag-find-symbol reference SharedStateBus
```

---

## 📝 ag-todo (v2.0.0+)

**Persistent agentic task management.**

A local-first task tracking tool that allows agents to maintain a "mental model" of their progress within the repo.

### Usage: ag-todo

```bash
# Add a new task
ag-todo add "Fix the memory leak in ASTCache"

# Mark a task as completed
ag-todo complete 1
```

---

## 🛠️ ag-edit

**Targeted surgical file manipulation.**

Unlike `sed` or `echo`, `ag-edit` is designed for complex multi-line transformations with built-in validation.

### Usage: ag-edit

```bash
# Replace a specific block of text
ag-edit replace --target "old_logic" --replacement "new_logic" src/utils.ts

# Append code to a specific function
ag-edit append --after "function init()" --content "  console.log('Nexus started');" lib/core.js
```

---

## 📊 ag-diff

**Semantic, machine-readable diff analysis.**

Generates diffs that are optimized for LLM context windows, highlighting structural changes rather than just character deltas.

### Usage: ag-diff

```bash
# View a summarized diff of a file
ag-diff src/main.ts --summary

# Compare two files with AST awareness
ag-diff file1.ts file2.ts --semantic
```

---

## 📸 ag-snapshot

**Persistent environment state persistence.**

Captures a byte-transparent snapshot of the current virtual environment, including environment variables, defined functions, CWD, and the OverlayFS state.

### Usage: ag-snapshot

```bash
# Save current state
ag-snapshot save pre-deployment-check

# Restore state after a failure
ag-snapshot restore pre-deployment-check
```

---

## 🔍 ag-analyze

**Structural script and codebase analysis.**

Uses the Tree-sitter engine to extract symbol tables, dependency graphs, and complexity metrics.

### Usage: ag-analyze

```bash
# Export symbol table
ag-analyze --symbols src/parser.ts

# Detect potential side-effects in a script
ag-analyze --detect-effects script.sh
```

---

## 🎯 Pro Tip: Agentic Synergy

Agents can use `ag-snapshot` to "branch" their experimentation. If a sequence of `ag-edit` commands leads to a broken state, the **Agentic Healer** can instantly suggest a `restore` or a specific symbol search to fix the context.
