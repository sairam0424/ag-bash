# 🚀 Nexus Agentic Suite

The **Nexus Agentic Suite** is a collection of high-fidelity tools designed to give autonomous agents surgical control over codebases and persistent environments.

---

## 🛠️ ag-edit
**Targeted surgical file manipulation.**
Unlike `sed` or `echo`, `ag-edit` is designed for complex multi-line transformations with built-in validation.

### Usage
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

### Usage
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

### Usage
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

### Usage
```bash
# Export symbol table
ag-analyze --symbols src/parser.ts

# Detect potential side-effects in a script
ag-analyze --detect-effects script.sh
```

---

## 🎯 Pro Tip: Agentic Synergy
Agents can use `ag-snapshot` to "branch" their experimentation. If a sequence of `ag-edit` commands leads to a broken state (detected via `ag-analyze`), the agent can instantly revert using `ag-snapshot restore` without affecting the real project files.
