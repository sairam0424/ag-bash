# 🏛️ Ag-Bash Architecture: Project V-Next (v2.4.1)

This document provides a deep dive into the high-performance architectural components introduced in the **v2.4.1 "Project V-Next"** and **v2.0.0 "Nexus Prime"** releases.

---

## 🏗️ High-Level Overview

Ag-Bash is designed as a **Secure Unified Agentic Runtime**. Unlike traditional shells, it optimizes for high-frequency agentic queries, cross-runtime visibility, and resource accounting.

```mermaid
graph TD
    User["Agent / User"] --> CLI["ag-bash CLI / MCP"]
    CLI --> Interpreter["Bash Interpreter"]
    
    subgraph "Nexus Core Engine"
        Interpreter --> Parser["Tree-sitter Parser"]
        Parser --> ASTCache["ASTCache (LRU)"]
        Interpreter --> Semantic["Semantic Intelligence Engine"]
        Interpreter --> Accounting["Resource Accounting (CPU/Mem/Net)"]
        Interpreter --> SharedBus["SharedStateBus"]
        Interpreter --> Events["EventEmitter (Observability)"]
    end
    
    subgraph "Runtimes"
        SharedBus --> Python["CPython (WASM)"]
        SharedBus --> JS["QuickJS (WASM)"]
    end
    
    subgraph "I/O Layer"
        Interpreter --> VFS["OverlayFS / InMemoryFS"]
        VFS --> RealFS["Host Filesystem (Read-only)"]
    end
```

---

## 🧠 Nexus AST Engine & ASTCache

To reduce the latency of script execution, Ag-Bash v1.5.0 introduces the **ASTCache**.

### The Problem

Traditional shells re-parse scripts every time they are executed. For autonomous agents that run many small commands in sequence, parsing represents a significant percentage of total execution time.

### The Solution: ASTCache

The `ASTCache` is a global LRU (Least Recently Used) cache that stores parsed Tree-sitter AST nodes.

- **Keying**: Input script strings are hashed using SHA-256 to create unique cache keys.
- **TTL**: Entries have a default TTL of 1 hour to prevent stale state in dynamic scripts.

- **Eviction**: A fixed memory footprint (default 100 entries) ensures the cache doesn't grow unbounded.

---

## ⚡ SharedStateBus: Inter-Runtime Communication

Project Nexus enables **Shared State Persistence** across Bash, Python, and JavaScript.

### Architecture

The `SharedStateBus` is a singleton event bus that allows different runtimes to synchronize variables and state changes.

- **Event-Driven**: Components publish events (e.g., `state:variable_set`) to the bus.
- **State Shadowing**: The bus maintains a "Shadow Map" of the current environment state accessible to any runtime.
- **Cross-Language Bindings**:
  - **Bash**: Access via `ag-snapshot` and environment expansion.
  - **Python/JS**: Access via built-in bridge libraries that communicate with the bus via the `Interpreter`.

---

## 🛡️ Resource Governance & Accounting

Ag-Bash v2.0.0 introduces hardened **Resource Accounting** to prevent runaway compute, memory, or network exhaustion in agentic loops.

### Performance Accounting

The `Interpreter` now accounts for resources in real-time:

- **Memory Tracking**: Estimates total object graph size during evaluation. If memory exceeds `maxMemoryAccountingBytes` (default 50MB), execution is aborted with an `ExecutionLimitError`.
- **CPU Time**: Tracks total execution time in milliseconds. If a script exceeds `maxCpuMs` (default 30s), the process is forcefully terminated.
- **Network Traffic**: Monitors total bytes sent/received via `curl`. Exceeding `maxNetworkTrafficBytes` (default 100MB) triggers immediate cancellation.
- **Agentic Nesting**: Prevents recursive agent loops by enforcing a maximum sub-agent depth via `maxAgentNesting` (default 3).

---

## 📡 Tooling 2.0: High-Fidelity Observability

Ag-Bash v2.4.0 introduces a standard **EventEmitter** interface for the `Bash` class, enabling real-time integration with external orchestrators and IDEs.

### Tool Lifecycle Events

The `BashToolbox` now emits structured events during tool execution:

- `tool:start`: Emitted before tool validation. Includes `toolName` and `args`.
- `tool:progress`: Emitted during long-running tool execution (if supported by the tool).
- `tool:end`: Emitted after tool completion. Includes `duration`, `status`, and `resultSummary`.

These hooks allow host applications to drive UI progress bars, performance telemetry, and audit logs without polling the interpreter state.

---

## 🩹 Agentic Healer 2.0: Semantic Discovery

The `AgenticHealer` has been refactored to be **environment-aware**, leveraging the full power of the tool registry for recovery.

### Tool-Aware Remediation

When a shell command fails, the healer doesn't just suggest text fixes. It now performs a **Semantic Discovery** pass:

1. **Failure Analysis**: Captures `stderr` and exit codes.
2. **Registry Scoring**: Uses a multi-keyword semantic scoring engine to find tools in the registry that match the failure context (e.g., `no such file` -> `analyze_code` or `ag-find-symbol`).
3. **Structured Remediation**: Provides the agent with a prioritized list of executable tools to fix the environment state.

---

## 🔍 Semantic Intelligence Engine

Nexus Prime introduces a native semantic analysis layer built directly into the shell evaluation loop.

### Capabilities

- **Command Explanation**: The `ag-explain` tool utilizes the Tree-sitter AST to provide structural breakdowns of complex pipelines, identifying flags, redirections, and subshells.
- **Symbol Indexing**: Global symbol discovery via `ag-find-symbol` allows agents to map function definitions and variable usages across the entire virtual filesystem.
- **Contextual Metadata**: `ag-hover` provides real-time documentation and type-hints for built-in and user-defined symbols.

---

## 📁 Virtual Filesystem (OverlayFS)

Ag-Bash utilizes an **Overlay Filesystem (CoW)** to ensure host safety.

- **Lower Layer**: Your actual project files (Read-only).
- **Upper Layer**: An ephemeral, in-memory layer for all writes.
- **Resolution**: Filename lookups merge these layers, giving the agent a seamless view while protecting the underlying disk.

---

## 🚀 Future Roadmap

- **Async Streaming I/O**: Implementing non-blocking stream pipes between WASM runtimes.
- **Global JIT Parser**: Pre-parsing entire repositories into the `ASTCache` for instant global lookups.
