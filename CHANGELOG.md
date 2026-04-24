# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [1.4.0] - Previously Released

### Added
- Tree-sitter parser integration for improved Bash script understanding.
- Support for Python and JavaScript runtimes within the shell.
- Integrated `AgenticHealer` for automated troubleshooting and recovery.

### Changed
- Migrated default parser engine from `legacy` to `tree-sitter`.
- Improved monorepo build pipeline and distribution artifacts.

## [1.3.0] - Legacy Release

### Added
- Initial support for `InMemoryFs` and `OverlayFs`.
- Basic command registry and lazy loading mechanism.
- Core shell integration for agentic environments.
