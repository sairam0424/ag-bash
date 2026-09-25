# 2026-09 Deep Research Sweep: Features, Best Practices, Upgrade Path, Optimization, Competitive Landscape

5-way parallel research + synthesis, grounded in ag-bash's real current state (v6.0.5/6.1.0, current npm/Dependabot backlog, existing security model). Sources cited inline; raw per-topic reports available on request.

## Executive Summary

Across all five reports, ag-bash's core architectural bets — in-process WASM execution instead of container/VM sandboxing, AST-based static destructive-command detection, and an npm-native supply chain — are validated by 2026 industry direction rather than undercut by it: LangChain's Deep Agents team independently converged on the same WASM-over-sandbox approach, and Cloudflare's own move to V8 isolates is a tacit admission that containers are too heavy for per-request agent code. But three concrete, unshipped gaps recur across the security and competitive-landscape reports: PR #113 (MCP tool-output sanitization) sits unmerged while OWASP's 2026 GenAI Top 10 and the NSA's MCP security paper both call this exact gap out by name; the Destructive Detection gate is WARN-only when 2026 guidance says high-confidence destructive patterns need a harder gate; and there is no domain-allowlist egress firewall, which every competing hosted sandbox (E2B, Modal, Daytona, Vercel, Cloudflare) now ships as baseline. Separately, the dependency backlog has one item that is not a judgment call — PR #151's `node:25-bookworm-slim` targets an already-EOL runtime and should be closed outright, not merged. On performance, the loudest actionable finding is that ag-bash's CJS bundle is 2.3MB (3.4x the 692KB ESM entry) purely because esbuild's `--splitting` doesn't apply to CJS output — a fixable, verified-in-repo defect, not a design tradeoff. Competitively, ag-bash should lean into "embeddable, zero-infra, no-metering, deterministic replay" positioning rather than chasing container/VM parity (arbitrary binaries, GPU, enterprise compliance) that its WASM security model structurally cannot match.

---

## Immediate Priorities (High priority, ready to act on)

Ordered by effort (small first). Overlapping recommendations from the security and competitive-landscape reports (both centered on PR #113) have been merged into one item.

| # | Priority item | Source report(s) | Effort |
|---|---|---|---|
| 1 | **Raise the Node engines floor to `^22.12.0`/`^24`+ and drop Node 20 from CI.** Both Node 20 and Node 25 are already EOL per nodejs.org's own release table; Vitest 5 and Changesets v3 both hard-require this floor. Do this before touching any other stalled PR. | Upgrade-path report | Small |
| 2 | **Close PR #151 (`node:25-bookworm-slim`) outright; open a fresh PR pinning `node:24-bookworm-slim`.** Node 25 entered Maintenance/EOL ~2026-03-31 (nodejs/Release#1122); Node 24 "Krypton" is genuinely Active LTS (nodejs/Release#1089) and already in ag-bash's tested matrix. | Upgrade-path report | Small |
| 3 | **Tier the Destructive Detection gate beyond WARN-only.** Move `rm -rf /`, fork-bomb, and decode-pipe-to-shell detections from uniform WARN to require explicit confirmation (or block, overridable) for high-confidence/high-blast-radius patterns, per OWASP GenAI 2026's "Rule of Two" and Anthropic's finding that approval fatigue makes deterministic gates — not model self-restraint — the real backstop. | Security/best-practices report | Small |
| 4 | **Wire esbuild `--metafile` analysis into CI as a size-regression gate**, mirroring the existing `bench-check.js` discipline. `size-limit` is already installed with no visible config; this would have caught the 692KB/2.3MB ESM/CJS divergence proactively. | Performance report | Small |
| 5 | **Reposition marketing around "embeddable, zero-infra, no-metering, sub-ms fork"** rather than competing on concurrency/scale with e2b/Modal/Cloudflare/Northflank. Don't chase Docker-in-ag-bash, GPU, or arbitrary-binary execution — that's a structurally different, VM/container-advantaged category. | Competitive-landscape report | Small |
| 6 | **Merge and extend PR #113 (MCP tool-output sanitization), message it as spec-gap coverage.** Before merging, verify it also strips Unicode Tag-block characters (U+E0000–E007F) and variation selectors (U+FE00–FE0F) on top of its existing ANSI/OSC/control-byte/bidi/Trojan-Source coverage (OWASP GenAI 2026 mitigation #5, citing Rehberger 2025c). This is the exact gap OWASP's MCP Top 10 (#3: tool poisoning), the NSA's MCP Security Design Considerations paper, and 2026 academic frameworks (SHIELDMCP, AttestMCP, MTGuard) call out as unaddressed by the base MCP spec — resolve the merge conflict and ship before further mcp-server work. Pair with an optional lightweight semantic classifier pass on tool output, since character-stripping alone is "necessary but not sufficient" per Anthropic's own finding. | Security report + Competitive-landscape report (merged) | Medium |
| 7 | **Implement the MCP Tasks extension (SEP-2663) and retire Sampling in `@ag-bash/mcp-server`.** Negotiate the 2026-07-28 protocol revision, add an ext-tasks-compliant task store keyed off existing job/session IDs so long shell/WASM/agent-runtime work returns a durable, crash-resumable task handle instead of blocking `tools/call`; stop relying on Sampling (deprecated by SEP-2577). | Features report | Medium |
| 8 | **Add a domain-allowlist, deny-by-default network egress firewall as a resource-budget dimension.** Every competing hosted sandbox (E2B, Vercel Sandbox, Cloudflare Sandboxes, Daytona) ships this as baseline in 2026; ag-bash's current network budget governs volume (100MB) but not destination. Extend the existing AsyncLocalStorage-based resource-budget enforcement layer. | Features report | Medium |
| 9 | **Add a safety-hardened, VFS-aware patch/diff-apply builtin.** Route writes through `resolveAndValidate()`, apply all-or-nothing with fuzzy hunk location, journal a reverse patch for undo — mirroring OpenAI's `apply_patch` and the 2026 "tolerant patch applier" ecosystem (diffapply, patchwise) instead of leaving agents to shell out to `patch`/`sed`. | Features report | Medium |
| 10 | **Land the Vitest 4→5 upgrade (PR bundle #130/#131/#71)** as a sequenced migration, not a blind bump — see Upgrade Path below. | Upgrade-path report | Medium |
| 11 | **Fix the CJS bundle bloat (2.3MB vs 692KB ESM entry).** Since `--splitting` is ESM-only in esbuild, move heavy optional deps (isomorphic-git, currently inlined) behind function-scoped `require()` calls inside the specific command handlers that use them. Verified directly against the repo's actual `--metafile` output. | Performance report | Medium |

---

## Upgrade Path

The concrete, sequenced dependency plan (repo-verified: `typescript ^5.9.3`, `vitest ^4.0.16`, `esbuild ^0.27.2`, `@changesets/cli ^2.31.0`, `Dockerfile FROM node:22-bookworm-slim`):

1. **Raise the Node floor first.** Bump `engines.node` off `>=20.6.0` to reflect that Node 20 and Node 25 are both EOL, and that Vitest 5 (`^22.12.0 || ^24.0.0 || >=26.0.0`) and Changesets v3 (`^22.11 || ^24 || >=26`) hard-require it. Drop Node 20 from the GitHub Actions matrix (ubuntu/macos/windows × Node 20/22/24), replace with 22/24/26, update README/CLAUDE.md. Ship as its own PR before #130/#131/#71/#152.
2. **Close PR #151; open a `node:24-bookworm-slim` PR** for the MCP server's Docker base image, sequenced after step 1 so the tag matches the updated CI matrix. Cite nodejs/Release#1122 (v25 EOL) and #1089 (v24 Active LTS through at least 2026-08) directly in the PR description.
3. **Land Vitest 4→5** (typescript@7.0.2-era migration guide applies): (a) confirm Node ≥22.12 and Vite ≥6.4; (b) rewrite every benchmark from top-level `bench(name, fn)` to the fixture form `test('x', async ({ bench }) => { await bench('name', fn).run() })` — hard removal, not deprecation; (c) grep custom config/reporters for `mode === 'benchmark'` checks and direct imports of `vitest/coverage`, `vitest/reporters`, `vitest/environments`, `vitest/snapshot`, `vitest/mocker`, `@vitest/runner` (all relocated/inlined); (d) re-run full coverage across unit/wasm/comparison configs since include/exclude glob matching got stricter; (e) audit the WASM worker-bridge test harness for 0-based `VITEST_POOL_ID`/`VITEST_WORKER_ID` assumptions (now 1-based); (f) temporarily set `clearMocks: false` to isolate upgrade failures from the new default-`true` behavior, then flip back and fix real leakage; (g) update CI artifact paths for the new single `.vitest/` output directory.
4. **Upgrade Changesets CLI v2.31→v3.0.1.** Rename `changeset tag`/`--sinceMaster` to `changeset git-tag`/`--since=<branch>`; audit any `changeset version` CI step run under `set -e` since v3 now exits 1 (not 0) when there's nothing to release; replace the `prettier` boolean in `.changeset/config.json` with `format`; check for private packages relying on default versioning (v3 stops versioning them unless `privatePackages.version: true`); bump `changesets/action` to v2.
5. **Do NOT adopt TypeScript 7.0 yet.** Two concrete blockers: microsoft/TypeScript#63705 is a confirmed declaration-emit regression triggered by symlinked installs (pnpm's entire `node_modules` layout) combined with `isolatedDeclarations`/`emitDeclarationOnly` — exactly ag-bash's build shape — that doesn't reproduce on 6.0.3; and TS7's initial release lacks the full Compiler API, breaking any tool that `import typescript` directly (ts-morph, typedoc, ts-patch, type-aware lint rules). Run `npm ls typescript` and grep for `from 'typescript'`/`require('typescript')` in scripts/tooling to check exposure. Bridge to TypeScript 6.0.x instead; revisit 7.0 once #63705 is fixed.
6. **Bump esbuild 0.27.2→0.28.2 and re2js 2.8.3→2.8.6** as independent, low-risk housekeeping — esbuild 0.28 added a warning for the TS7 "confusing-typescript-cast" precedence change, a free pre-flight check ahead of any future TS7 migration; re2js underpins a documented ReDoS-defense security control, so re-run those test paths after the bump.

---

## New Features Worth Building

- **MCP Tasks extension (SEP-2663)** — durable task handles, `tasks/get` polling, `input_required` mid-flight elicitation, crash-resumable via persisted task IDs for long shell/WASM/agent-runtime work; retire Sampling (deprecated by SEP-2577). High priority, medium effort.
- **Domain-allowlist egress firewall** as a new resource-budget dimension, deny-by-default, surfaced as Observation-level events rather than silent failures. High priority, medium effort.
- **VFS-aware patch/diff-apply builtin** — unified-diff/search-replace/V4A-style input, all-or-nothing atomicity, fuzzy hunk location (never fuzzing deletions), reverse-patch undo journal, exposed both as a core builtin and an MCP tool. High priority, medium effort.
- **OpenTelemetry GenAI semantic-convention alignment for `AgBashTracer`** — opt-in mapping layer emitting `execute_tool` spans with current `gen_ai.tool.name`/`gen_ai.tool.call.id` attributes, plus `ag_bash.*` extensions for ground-truth CPU/memory usage that pure LLM-proxy cost tools can't see. Medium priority, small effort.
- **Resource/cost accounting on `Observation` objects** — add CPU time, peak memory, and WASM invocation count fields, plus a metering hook/adapter shaped to plug into the emerging run-aware cost-governance middleware category (AgentLedger's "MCP tool metering," TokenOps, agent-budget-controller). Medium priority, medium effort.
- **Full `ServiceContainer`+VFS+WASM-worker checkpoint/restore API**, distinct from RunLoop v2's `AgentMemory` — a portable blob that survives a process crash or host restart, extending ag-bash's existing sub-millisecond `fork()`/`speculate()` advantage to cross-process/cross-host resumability. Medium priority, large effort.
- *(Explicitly deprioritized, low priority: don't build a competing multi-agent coordination protocol inside ag-bash — publish a minimal A2A Agent Card for the mcp-server/agent-bridge instead, since A2A is gaining real 2026 adoption for cross-process delegation and MCP/A2A are consistently framed as complementary, not competing.)*

---

## Best Practices Gaps

Gaps genuinely identified against 2026 practice — not things ag-bash already does well (the AST-based Destructive Detection gate itself, pnpm's default-blocked postinstall scripts, and npm Trusted Publishing/OIDC provenance are all confirmed differentiators, not gaps):

- **Destructive Detection gate is WARN-only for everything**, including `rm -rf /` and fork-bomb-class patterns — out of step with OWASP GenAI 2026's "Rule of Two" and human-confirmation-for-irreversible-action guidance, and with Anthropic's explicit finding that approval fatigue makes deterministic gates (not model self-restraint) the real backstop.
- **No domain-allowlist/egress-firewall abstraction** — the existing network budget (100MB) governs volume, not destination, while every peer hosted sandbox now ships deny-by-default egress firewalls as baseline.
- **MCP tool-output sanitization (PR #113) is unmerged**, and per OWASP's MCP Top 10 (#3: tool poisoning) and the NSA's MCP Security Design Considerations paper, syntactic stripping alone is "necessary but not sufficient" — Anthropic's own finding is that a poisoned tool return "looks like a successful, authorized API call" in logs, meaning a semantic inspection layer before tool output re-enters agent context is the missing second control.
- **No tool-definition hash pinning ("rug-pull" detection)** for the mcp-server's 70 tools — a compromised server can mutate tool descriptions/metadata post-review, and neither the bare MCP Registry nor ag-bash's own release process currently detects this drift.
- **No load-time integrity/signature verification for bundled `.wasm` binaries**, distinct from npm provenance. npm Trusted Publishing/Sigstore attests the tarball at *publish* time only; there is no load-time check immediately before `Module` instantiation, leaving a gap if a `.wasm` file is substituted or corrupted post-publish.
- **Unverified/open question, flagged as such by its own source report:** it is *not verifiable from public sources* which WASI generation (Preview 1's flat/ambient-authority model vs. the stabilized, materially stronger Preview 2 component/capability model) ag-bash's CPython/QuickJS/SQLite3 WASM workers actually target. This needs an internal audit rather than being assumed handled — and a related check that ag-bash does **not** lean on Node's built-in `node:wasi` for any part of the security boundary, since Node's own docs disclaim that it provides comprehensive file-system security for untrusted code.
- **Docker MCP Catalog submission path unconfirmed** — Docker's contributing guide treats the "Docker-built image" path (signed, SBOM, provenance attestation, auto security updates) as materially more trustworthy than "self-provided pre-built image" (container isolation only); given how low-signal the raw MCP Registry has become (62% of ~30k entries published once and abandoned), confirm ag-bash's pending submission uses the Docker-built path.

---

## Optimization Opportunities

- **Fix CJS bundle bloat (2.3MB vs 692KB ESM).** esbuild's `--splitting` flag is ESM-only, so ag-bash's `build:lib:cjs` script eagerly inlines all ~219 lazily-loaded chunks (largest: a 226.8KB isomorphic-git bundle) that ESM consumers defer via dynamic `import()`. Move heavy optional deps behind function-scoped `require()` calls inside the specific command handlers that use them, or evaluate shipping a thin CJS shim that lazy-loads the ESM build via dynamic `import()` at first call. Verified directly against the repo's own `esbuild --metafile` output.
- **Wire `--metafile` analysis into CI as a size-regression gate**, mirroring the existing bench-regression discipline — would have caught the 692KB/2.3MB divergence proactively.
- **Ship a pre-warmed Node compile cache for the `ag-bash`/`ag-shell` CLI bins** via `module.enableCompileCache()`/`NODE_COMPILE_CACHE` (stable since Node 22.1, with a `readOnly` mode for ahead-of-time-generated caches) — directly targets the repeated-cold-process pattern the CLI bins represent; Cloudflare's workerd reports 20-40% V8-level / up to 56% Node-built-in-module boot-time improvements from the equivalent.
- **Prototype Wizer for the CPython WASM worker.** Wizer (Bytecode Alliance) snapshots an already-initialized WASM instance into a new module, with official benchmarks showing 1.35x-6.00x faster instantiation depending on init-work weight (up to 98.297ms→16.385ms for a heavy parser) — squarely aimed at ag-bash's heavy-interpreter-boot-before-first-exec pattern, far more than QuickJS's.
- **Move the bench-regression gate to a dedicated/consistent runner (or CodSpeed-style backend)** instead of compensating for CI noise with a raised threshold. `bench-check.js`'s inline changelog shows the gate was raised from 15%→25% on 2026-09-23 after 3+ months of false positives on shared `ubuntu-latest` runners — the raised threshold treats the symptom (runner contention), not the root cause, and a dedicated runner would let sensitivity move back toward 15% without reintroducing the original flakiness.
- **Harden tree-sitter/web-tree-sitter grammar loading**: confirm `Parser.init()` is called exactly once behind a cached promise, grammars are cached in a `Map<language, Language>`, multiple grammars load **sequentially** (web-tree-sitter has a documented WASM-heap race under concurrent `Language.load()` on Node), and `.wasm` files are read as `Uint8Array` buffers rather than passed as path strings (path-based loading triggers an internal dynamic `import()` that sandboxed/VM contexts — relevant given ag-bash's own AsyncLocalStorage sandboxing — can reject).

---

## Competitive Positioning

**Where ag-bash wins structurally:**
- No network hop to a remote sandbox, no per-second/per-vCPU metering, no shared-infrastructure concurrency ceiling — every competitor researched (E2B/Firecracker, Modal/gVisor, Daytona/containers, Vercel Sandbox/Firecracker, Cloudflare Sandboxes) is a hosted or BYOC service with ~90ms-3s cold starts and hard concurrency caps (100-1,100 for E2B; 1,000-15,000 for Cloudflare).
- **Validated by a major player, not just internal reasoning**: LangChain's Deep Agents team published (June 2026) their own choice of WASM+QuickJS in-process execution over a remote sandbox, citing the same rationale ag-bash relies on, and naming AWS, Shopify, and Figma as other production WASM-for-untrusted-code adopters. Cloudflare's own March 2026 Dynamic Worker Loader launch (moving to V8 isolates for ~100x faster boot, 10-100x lower memory) is a tacit admission from the largest container-sandbox vendor that containers aren't lightweight enough for the exact "agent writes a snippet, runs it once, throws it away" pattern ag-bash targets.
- **Deterministic replay is a real, differentiated capability worth naming explicitly.** Because all external IO in ag-bash's model is forced through an explicit host-capability bridge (`fork()`/`speculate()`, `SharedStateBus`, typed `Observation` objects), near-perfect reproducibility is achievable in a way container/VM competitors structurally cannot offer (real OS = real nondeterminism). Verify this is demonstrable end-to-end and market it as a named, benchmarked feature rather than an implicit side effect.
- Command-level static analysis (the Destructive Detection gate) is a genuine differentiator versus every peer sandbox — none of E2B/Modal/Daytona attempt this; they rely purely on kernel/VM-level blast-radius containment (and Daytona's default `runc` runtime has historically run `Privileged:true`, disabling seccomp/AppArmor).

**Where ag-bash does not, and should not try to, compete:**
- Arbitrary Linux binaries, apt/pip C-extension packages, Docker-in-Docker, full desktop/computer-use with VNC (e2b Desktop, Daytona Windows/macOS VMs) — WASM CPython/QuickJS/SQLite3 runtimes cannot execute arbitrary compiled binaries or drive a display server.
- GPU workloads for training/inference (Daytona, Northflank ship H100/H200/RTX sandboxes) — no WASM path to CUDA.
- Massive shared-infrastructure multi-tenancy where mutually distrusting end-users need a kernel/hypervisor boundary rather than a language-level trust boundary in the same host process.
- Enterprise compliance posture (SOC 2, HIPAA, GDPR, dedicated BYOC VPC deployment) — e2b, Daytona, and Northflank already have or are actively building this; a library has no equivalent since no vendor operates the workload.

**What to message, concretely:**
- Lead with "embeddable, zero-infra, no-metering, sub-millisecond fork" contrasted explicitly against e2b/Daytona's ~90-150ms cold starts and per-second billing, and cite Cloudflare's own Dynamic Worker Loader admission.
- Treat shipping PR #113 as a headline "we already built the fix the industry just formally identified as missing" story (OWASP MCP Top 10 #3, NSA MCP paper) rather than a routine bugfix.
- Confirm and prioritize the Docker MCP Catalog's "Docker-built image" submission path over the bare MCP Registry listing, since the raw Registry has become low-signal (62% of ~30k entries published once and abandoned).

---

## Sources

*Grouped by topic; deduplicated across all five reports. Two entries are direct repo/tooling verification, not external citations, and are marked as such.*

**MCP protocol, Tasks extension, Sampling deprecation**
- https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks
- https://tasks.extensions.modelcontextprotocol.io/
- https://modelcontextprotocol.io/seps/2663-tasks-extension
- https://modelcontextprotocol.io/extensions/tasks/overview.md
- https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- https://mcp-staging.mintlify.app/specification/2026-07-28/client/sampling
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/index.mdx
- https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- https://code.claude.com/docs/en/agent-sdk/hosting

**MCP security, tool poisoning, ecosystem health**
- https://genai.owasp.org/download/56857/ (OWASP Top 10 for LLM Applications 2026)
- https://github.com/GenAI-Security-Project/GenAI-LLM-Top10/blob/main/README.md
- https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html
- https://owasp.org/www-community/attacks/MCP_Tool_Poisoning
- https://media.defense.gov/2026/Jun/02/2003943289/-1/-1/0/CSI_MCP_SECURITY.PDF (NSA MCP Security Design Considerations)
- https://www.nsa.gov/Portals/75/documents/Cybersecurity/CSI_MCP_SECURITY.pdf
- https://www.mdpi.com/2624-800X/6/3/84 (MCP threat modeling / tool poisoning study)
- https://www.docker.com/blog/mcp-security-explained/
- https://www.docker.com/blog/mcp-server-best-practices/
- https://unit42.paloaltonetworks.com/model-context-protocol-attack-vectors/
- https://www.exploreagentic.ai/insights/mcp-server-security-hardening/
- https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-tool-poisoning-auto-execution-20260701/
- https://arxiv.org/pdf/2601.17549v1 (AttestMCP)
- https://aclanthology.org/2026.acl-industry.58.pdf (SHIELDMCP)
- https://arxiv.org/abs/2607.25297 (MTGuard)
- https://github.com/docker/mcp-registry
- https://docs.docker.com/ai/mcp-catalog-and-toolkit/faqs/
- https://devtoolhub.com/mcp-registry-by-the-numbers/
- https://www.digitalapplied.com/blog/mcp-ecosystem-h1-2026-retrospective-adoption-data-points
- https://alatirok.com/mcp-server-statistics-2026/
- https://dataku.ai/blog/mcp-server-ecosystem-4000-tools-counting
- https://mcphq.ai/news/2026-07-06-new-mcp-servers
- https://github.com/ogasurfproject-jpg/mcp-registry-survey

**Anthropic / agent containment & tool design**
- https://www.anthropic.com/engineering/claude-code-sandboxing
- https://www.anthropic.com/engineering/how-we-contain-claude
- https://www.anthropic.com/engineering/code-execution-with-mcp
- https://www.anthropic.com/engineering/writing-tools-for-agents
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool

**A2A protocol**
- https://a2a-protocol.org/latest/
- https://agent2agent.info/docs/topics/a2a-and-mcp/
- https://zylos.ai/research/2026-05-16-agent-to-agent-communication-protocols-a2a-mcp/
- https://beam.ai/agentic-insights/agent2agent-vs-mcp-2026-ai-agent-stack
- https://arxiv.org/html/2607.23884

**OpenTelemetry GenAI semantic conventions**
- https://opentelemetry.io/blog/2026/genai-observability/
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md
- https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/model/gen-ai/spans.yaml
- https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/

**Agent cost/spend governance**
- https://github.com/WDZ-Dev/agent-ledger
- https://registry.npmjs.org/%40grislabs%2Fagentmeter
- https://github.com/ogulcanaydogan/LLM-Cost-Guardian
- https://github.com/theagentplane/tokenops
- https://github.com/pntech20/agent-budget-controller
- https://paybond.ai/guides/microsoft-agent-framework-spend-controls

**Patch/diff-apply tooling**
- https://developers.openai.com/api/docs/guides/tools-apply-patch
- https://github.com/JohnXu22786/apply-patch
- https://aider.chat/docs/more/edit-formats.html
- https://aider.chat/docs/unified-diffs.html
- https://github.com/judysonnen/patchwise
- https://github.com/Amarel-Taylor-Scott/diffapply

**WASM/WASI security model & Ruby WASM**
- https://wasi.dev/security
- https://wasi.dev/roadmap
- https://wasi.dev/releases/wasi-p2
- https://docs.wasmtime.dev/security.html
- https://docs.wasmtime.dev/api/wasmtime_wasi/p2/index.html
- https://github.com/WebAssembly/WASI/blob/v0.2.11/docs/Preview2.md
- https://nodejs.org/docs/latest-v26.x/api/wasi.html
- https://www.systemshardening.com/articles/wasm/wasi-preview-2-capabilities/
- https://www.systemshardening.com/articles/wasm/wasm-module-signing-cose/
- https://dl.acm.org/doi/full/10.1145/3795882 (WaSC WASM sandbox hardening paper)
- https://docs.flow-like.com/dev/wasm-nodes/sandboxing/
- https://safeguard.sh/resources/blog/wasm-webassembly-security-considerations
- https://github.com/ruby/ruby.wasm/
- https://ruby.github.io/ruby.wasm/
- https://blog.aotoki.me/en/posts/2026/05/20/kobako-ruby-sandbox-for-ai/

**npm supply chain & provenance**
- https://github.com/npm/rfcs/blob/main/implemented/0049-link-packages-to-source-and-build.md
- https://jfrog.com/blog/npm-v12-from-implicit-to-explicit-trust/

**ReDoS / regex security**
- https://www.npmjs.com/package/re2js
- https://www.npmjs.com/package/re2
- https://github.com/le0pard/re2js/releases
- https://dl.acm.org/doi/10.1145/3708821.3733912 (SoK: ReDoS literature and engineering review)

**TypeScript 7 / TS6 migration**
- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- https://fernforge.github.io/devnotes/typescript-7-what-breaks/
- https://github.com/microsoft/TypeScript/issues/63705

**Vitest 5 migration**
- https://vitest.dev/guide/migration/
- https://vitest.dev/blog/vitest-5.html
- https://github.com/vitest-dev/vitest
- https://codingdunia.com/blog/vitest-5-migration-guide/
- https://vitest.dev/guide/benchmarking.html
- https://vitest.dev/config/benchmark
- https://qaskills.sh/blog/vitest-benchmark-mode-regression-tracking
- https://codspeed.io/blog/vitest-bench-performance-regressions
- https://www.pkgpulse.com/guides/tinybench-vs-mitata-vs-vitest-bench-2026

**Node.js release lifecycle**
- https://nodejs.org/en/about/previous-releases
- https://github.com/nodejs/Release/issues/1089
- https://github.com/nodejs/Release/issues/1122
- https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule
- https://nodejs.org/api/module.html

**Changesets v3**
- https://changesets.dev/guide/migration
- https://changesets.dev/blog/announcing-changesets-v3
- https://www.infoq.com/news/2026/09/changesets-v3-release/
- https://github.com/changesets/changesets/releases/tag/%40changesets%2Fcli%403.0.0

**esbuild**
- https://github.com/evanw/esbuild/releases/tag/v0.28.2
- https://esbuild.github.io/faq/
- https://esbuild.github.io/api/
- https://github.com/evanw/esbuild/issues/3497
- https://github.com/evanw/esbuild/issues/1934
- https://github.com/evanw/esbuild/issues/1698
- https://frontend-build-tooling.com/esbuild-turbopack-workflows/esbuild-api-and-cli-for-rapid-builds/reducing-esbuild-bundle-size-with-minify-and-treeshaking/

**Tree-sitter**
- https://github.com/tree-sitter/tree-sitter/pull/4208
- https://github.com/tree-sitter/tree-sitter/issues/1580
- https://deepwiki.com/tree-sitter/tree-sitter/5.2-grammar-loader

**WASM cold-start / compile caching performance**
- https://web.dev/articles/webassembly-performance-patterns-for-web-apps
- https://github.com/bytecodealliance/wizer
- https://fitzgen.com/2021/05/10/wasm-summit-2021.html
- https://v8.dev/blog/wasm-code-caching
- https://github.com/cloudflare/workerd/pull/2952
- https://www.npmjs.com/package/quickjs-emscripten
- https://registry.npmjs.org/pyodide
- https://github.com/pyodide/pyodide/issues/6032

**Edge/sandbox resource-budget comparisons**
- https://www.edge-middleware.com/edge-runtime-fundamentals-platform-constraints/memory-and-cpu-limits-across-edge-providers/
- https://vercel.com/kb/guide/vercel-sandbox-vs-e2b
- https://github.com/denoland/docs (sandboxes/index.md)

**Competitive sandbox landscape (E2B, Modal, Daytona, Cloudflare, Vercel, Northflank, Val Town, Riza)**
- https://e2b.dev/ (E2B — The Enterprise AI Agent Cloud)
- https://e2b.dev/enterprise
- https://www.e2b.dev/pricing
- https://www.daytona.io/ and https://www.daytona.io/docs/en/
- https://www.daytona.io/pricing
- https://github.com/daytonaio/daytona
- https://modal.com/products/sandboxes
- https://modal.com/solutions/coding-agents
- https://modal.com/docs/guide/sandboxes.md
- https://blog.cloudflare.com/sandbox-ga/
- https://blog.cloudflare.com/dynamic-workers/
- https://developers.cloudflare.com/sandbox/
- https://developers.cloudflare.com/agents/tools/sandbox/
- https://blog.val.town/plugin
- https://docs.val.town/
- https://docs.riza.io/getting-started/how-it-works
- https://docs.riza.io/interpreters/security
- https://docs.riza.io/api-reference/command/execute-function
- https://northflank.com/product/sandboxes
- https://northflank.com/blog/best-code-execution-sandbox-for-ai-agents
- https://northflank.com/blog/what-is-an-ai-sandbox
- https://rywalker.com/research/ai-agent-sandboxes
- https://agentscamp.com/guides/advanced/sandboxing-ai-generated-code
- https://www.reactify-solutions.com/articles/code-execution-sandboxes-ai-agents-2026
- https://blog.logrocket.com/comparing-ai-agent-sandbox-platforms-e2b-modal-daytona-and-more/
- https://ai-solutions.wiki/comparisons/e2b-vs-daytona-vs-modal/
- https://aiworkflowlab.dev/article/agent-sandboxes-e2b-modal-daytona-cloudflare
- https://gethasp.com/guides/modal-vs-e2b-vs-daytona-agent-sandboxes/
- https://pub.towardsai.net/e2b-vs-daytona-vs-modal-vs-docker-how-ai-agent-sandboxes-actually-differ-bd1ea9bb3333
- https://dreaming.press/posts/how-to-run-untrusted-agent-code-e2b-modal-starters.html

**In-process WASM peers / prior art**
- https://github.com/Parassharmaa/agent-sandbox/
- https://github.com/mayflower/wasmsh
- https://github.com/tjfontaine/agent-in-a-browser/
- https://news.ycombinator.com/item?id=46824877 (amla-sandbox HN discussion)
- https://www.langchain.com/blog/running-untrusted-agent-code-without-a-sandbox

**Direct repo/tooling verification (not external citations)**
- Local repo inspection: `/Users/sairamugge/Desktop/Not-Humans-World/Ag-Bash/ag-bash/package.json`, `Dockerfile`, `packages/bash/package.json`, `packages/bash/scripts/bench-check.js`, and live `esbuild --metafile` runs against the actual `build:lib`/`build:lib:cjs` commands.

---

**Note on evidentiary strength:** one item is explicitly flagged by its own source report as unverified rather than sourced — *"It is not verifiable from public sources which WASI generation ag-bash's CPython/QuickJS/SQLite3 WASM runtimes target."* This is called out above under Best Practices Gaps as an internal-audit item, not a confirmed finding. Everything else in this document traces to a cited source, a dated release/CVE/GHSA identifier, or direct repo/build inspection (esbuild `--metafile`, `bench-check.js` inline comments, `package.json`/`Dockerfile` contents).