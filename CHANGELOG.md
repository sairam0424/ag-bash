# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
