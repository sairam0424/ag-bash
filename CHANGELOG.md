# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.0] - 2026-04-26

### Added (Project V-Next Upgrade - Enhanced Tooling)

- **Unified Tooling Architecture**:
  - Standardized `ToolboxTool` interface across all agentic tools for consistent execution and validation.
  - Decoupled `buildTool` factory to eliminate circular dependencies and improve build stability.
- **Enhanced Agentic Tools**:
  - `ag_edit`: New high-performance file editor with multi-chunk support and SHA-256 staleness protection.
  - `ag_grep`: Optimized recursive search tool with unified `GrepTool` wrapper.
  - `ag_todo`: Integrated task management with persistent storage for agent memory.
  - `ag_convert`: Document-to-markdown conversion with smart engine routing.
  - `ag_lsp`: Unified LSP-driven tool for code navigation, symbol search, and documentation.
- **Security & Governance**:
  - **Plan Mode Enforcement**: Destructive tools are now automatically blocked when the shell is in `plan` mode.
  - **Staleness Protection**: Added hash verification to `ag_edit` to prevent overwriting concurrent changes.
  - **Permission Manager**: Fine-grained access control for sensitive tool executions.

### Changed

- Synchronized monorepo versions to **v2.6.0** across `@ag-bash/bash`, `@ag-bash/mcp-server`, and `@ag-bash/agent-bridge`.
- Refactored `EditTool` and `SearchTool` to use the unified tooling architecture.

## [2.5.0] - 2026-04-25

### Added (Project V-Next Upgrade - Final)

- **Advanced Tooling & Protocol Support**:
  - **Real MCP Client**: Implemented a full JSON-RPC 2.0 client for Model Context Protocol servers. Supports high-performance **Stdio** (process spawning) and **HTTP** (fetch) transports.
  - **Dynamic Tool Discovery**: Automated tool registration from MCP servers with JSON-schema mapping to internal Zod schemas.
  - **Interactive Permissions**: Centralized `PermissionManager` for managing sensitive tool access with support for `allow`, `deny`, and `ask` behaviors.
- **New Agentic Command Suite**:
  - `ag-plan`: Dedicated Planning Mode for multi-step designs with checkpoints and read-only state safety.
  - `ag-notebook`: Direct manipulation of Jupyter Notebooks (`.ipynb`) with cell-level editing and structural analysis.
  - `ag-mcp`: Comprehensive management CLI for MCP server lifecycles and tool execution.
- **Observability & Diagnostics**:
  - **AgTrace Heuristics**: Added specialized failure analysis for MCP connection issues and Notebook malformations.
  - **Path Safety**: Standardized path resolution across all new commands to ensure sandbox integrity.

### Changed

- Synchronized monorepo versions to **v2.5.0** across `@ag-bash/bash`, `@ag-bash/mcp-server`, and `@ag-bash/agent-bridge`.
- Refactored `McpClient` to handle asynchronous transport initialization and eliminate race conditions.

## [2.4.1] - 2026-04-25

### Fixed (Stability & Compatibility)

- **Build Pipeline**: Resolved Tree-Sitter WASM resolution issues in browser and Next.js environments by ensuring proper asset propagation to `dist/bundle/`.
- **Browser Compatibility**: Implemented a functional `EventEmitter` shim for browser bundles, fixing the `Class extends value undefined` runtime error.
- **Interpreter Refinements**: Fixed an issue with indented heredocs (`<<-EOF`) normalization in `Bash.exec`.
- **Log Hygiene**: Suppressed `direct-eval` and `empty-import-meta` warnings in the build output for cleaner logs.

## [2.4.0] - 2026-04-24

### Added (Project V-Next Upgrade)

- **Tooling 2.0 & Orchestration**:
  - **Full Observability**: Integrated `EventEmitter` into `Bash` for real-time tool lifecycle tracking.
  - **Precision Hooks**: Standardized `tool:start`, `tool:progress`, and `tool:end` events with duration telemetry.
  - **Telemetry Reports**: Automated generation of high-fidelity tool execution reports for host monitoring.
- **Agentic Healer 2.0**:
  - **Context-Aware Healing**: Injected `BashToolbox` into the healer for deeper environment introspection.
  - **Semantic Discovery**: Automated tool suggestions (e.g., `analyze_code`, `fix_missing_file`) when shell commands fail.
  - **Smart Scoring**: Multi-keyword semantic scoring engine for reliable tool recovery from complex failure strings.
- **Resource & Security Hardening**:
  - **Artifact Spillover**: Automated persistence for large tool outputs (>100kb) to ensure stability and reduce token pressure.
  - **Gated Permissions**: Enhanced `behavior: 'ask'` support for secure, interactive approval of sensitive operations.
  - **MCP Namespacing**: Improved tool synchronization and resource isolation across multi-namespace registries.

## [2.1.0] - 2026-04-24

### Added (Project Hyperion Upgrade)

- **High-Fidelity Document Intelligence**:
  - `ag-convert`: Intelligent document-to-markdown converter powered by **Hyperion** (IBM Docling + Microsoft MarkItDown).
  - **Smart Routing**: Automated engine selection based on document complexity and structural requirements.
  - **Visual Intelligence (Phase 4)**: AI-powered image description support with multi-provider LLM integration (OpenAI, Anthropic, Google, Local).
  - **Vision Modes**: Specialized prompts for OCR, diagram analysis, chart decoding, and UI screenshot breakdown.
- **Environment Stability**:
  - Absolute Python path resolution to ensure consistent dependency access across `pyenv` and `conda` environments.
  - Hardened OverlayFS path translation for seamless host-side tool integration.
- **Maintenance**:
  - Silenced redundant LSP `ENOENT` warnings to improve CLI output clarity.
  - Comprehensive v2.1 test suite for Document Intelligence validation.

## [2.0.0] - 2026-04-23

### Added (Project Nexus Prime Upgrade)

- **Intelligent Semantic Suite**:
  - `ag-hover`: Contextual metadata and documentation for symbols at a specific location.
  - `ag-explain`: AST-driven pipeline explanation for complex shell commands.
  - `ag-find-symbol`: Global workspace indexing and search for symbol definitions and references.
  - `ag-todo`: Persistent local task management and project tracking for agents.
- **Hardened Governance**:
  - `maxNetworkTrafficBytes`: Session-wide network traffic accounting and enforcement (100MB default).
  - `maxAgentNesting`: Hard limit on agent recursion depth to prevent infinite loops in multi-agent workflows.
  - Enhanced `ExecutionLimitError` (Exit code 126) for granular resource breach reporting.
- **Security & Stability**:
  - Defensive AST traversal in `ag-explain` to handle malformed or partial scripts.
  - Improved argument parsing to resolve conflicts between shell flags and command-specific options.
  - Comprehensive v2.0 Smoke Test suite for feature validation and regression testing.

### Changed

- Upgraded the entire monorepo to version 2.0.0.
- Synchronized versioning across `@ag-bash/bash`, `@ag-bash/mcp-server`, and `@ag-bash/agent-bridge`.
- Refactored `Interpreter` to enforce Nexus Prime resource limits.

## [1.5.0] - 2026-04-20

### Added (Project Nexus Upgrade)

- **Agentic Command Suite**:
  - `ag-edit`: Robust line-based file editor for precise surgical edits.
  - `ag-diff`: High-fidelity diff tool with semantic summaries optimized for LLMs.
  - `ag-snapshot`: Persistent state capture (env, functions, CWD, VFS) in `.ag-snapshots/`.
  - `ag-analyze`: Structural script analysis with symbol table export.
- **Core Architecture**:
  - `ASTCache`: Global LRU cache for parsed ASTs to reduce re-parsing overhead.
  - `SharedStateBus`: Event-driven bridge for synchronized state between Bash and external runtimes (Python/JS).
- **Hardening**:
  - Real-time memory and CPU accounting in the `Interpreter`.
  - Configurable `maxMemoryAccountingBytes` and `maxCpuMs` limits.

### Changed

- Refactored `Interpreter` to support `SharedStateBus` event hooks.
- Updated `SemanticEngine` to expose `getAllSymbols()` for automated analysis.
- Hardened prototype pollution defenses in command argument parsing.

## [1.4.0] - 2026-04-15

### Added

- Tree-sitter parser integration for improved Bash script understanding.
- Support for Python and JavaScript runtimes within the shell.
- Integrated `AgenticHealer` for automated troubleshooting and recovery.

### Changed

- Migrated default parser engine from `legacy` to `tree-sitter`.
- Improved monorepo build pipeline and distribution artifacts.

## [1.3.0] - 2026-04-10

### Added

- Initial support for `InMemoryFs` and `OverlayFs`.
- Basic command registry and lazy loading mechanism.
- Core shell integration for agentic environments.
