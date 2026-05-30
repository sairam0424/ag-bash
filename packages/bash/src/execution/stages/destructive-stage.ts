/**
 * DestructiveStage - Gated, AST-based destructive-command detection (E2).
 *
 * Runs AFTER the parse stage (so the AST is available) and BEFORE the
 * interpret stage. It analyzes the PARSED AST — not the flat command string —
 * so structural obfuscations are caught (command substitution, $IFS expansion,
 * fork bombs, decode-pipe-to-shell) while dangerous strings that merely sit in
 * an `echo`/`grep` ARGUMENT are NOT flagged.
 *
 * Policy (default WARN):
 *   - "warn"   : attach a typed Observation + stderr warning line, then STILL
 *                EXECUTE. The warning is stashed on the pipeline context and
 *                merged into the interpreter-produced result by the runner.
 *   - "block"  : short-circuit with a non-zero result WITHOUT interpreting.
 *   - "prompt" : no interactive prompt is possible in-process, so this falls
 *                back to BLOCK behavior with a note in stderr. Documented.
 *   - "allow"  : do nothing (detection disabled at the gate).
 *
 * The default WARN policy is deliberately NON-BREAKING: every command that ran
 * before this stage existed STILL runs — WARN executes.
 */

import type { Observation } from "../../types.js";
import type { BashExecResult } from "../../types.js";
import { mapToRecordWithExtras } from "../../helpers/env.js";
import {
  analyzeDestructiveAst,
  type DestructiveAstFinding,
} from "../../security/destructive-command-detector.js";
import type { PipelineContext, PipelineStage, StageResult } from "../types.js";

/**
 * How the gate responds to a detected destructive command.
 * Default is "warn" (attach observation + stderr, still execute).
 */
export type DestructivePolicy = "warn" | "block" | "prompt" | "allow";

/** Exit code used when BLOCK (or PROMPT→block) short-circuits a destructive command. */
const BLOCK_EXIT_CODE = 126;

/**
 * Build the typed Observation for a destructive finding. Uses the existing
 * "destructive" Observation type with the finding's stable machine `code` and
 * a confidence of 1.0 (the AST analyzer KNOWS the structural cause).
 */
function findingObservation(finding: DestructiveAstFinding): Observation {
  return Object.freeze({
    type: "destructive",
    code: finding.code,
    confidence: 1,
    message: `Destructive command detected: ${finding.command} ${finding.pattern}.`,
    command: finding.command,
    context: Object.freeze({
      category: finding.category,
      severity: finding.severity,
    }),
  });
}

/** Human-readable stderr warning line for a finding (newline-terminated). */
function findingStderr(finding: DestructiveAstFinding): string {
  return `bash: warning: destructive command detected: ${finding.command} ${finding.pattern} [${finding.code}]\n`;
}

export class DestructiveStage implements PipelineStage {
  readonly name = "destructive";

  private readonly defaultPolicy: DestructivePolicy;

  /**
   * @param defaultPolicy - Instance-level policy (from BashOptions). Defaults
   *   to "warn". A per-call ExecOptions.destructivePolicy overrides this.
   */
  constructor(defaultPolicy: DestructivePolicy = "warn") {
    this.defaultPolicy = defaultPolicy;
  }

  async execute(context: PipelineContext): Promise<StageResult> {
    const { ast, options, execState } = context;

    // Per-call override beats the instance default.
    const policy: DestructivePolicy =
      options?.destructivePolicy ?? this.defaultPolicy;

    // ALLOW disables the gate entirely; nothing to do.
    if (policy === "allow" || ast === undefined) {
      return { continue: true, context };
    }

    const finding = analyzeDestructiveAst(ast, context.normalizedScript);
    if (!finding) {
      return { continue: true, context };
    }

    // WARN: stash the warning so the runner merges it onto the result. The
    // script STILL executes — continue to the interpret stage.
    if (policy === "warn") {
      context.pendingDestructiveWarning = {
        observation: findingObservation(finding),
        stderr: findingStderr(finding),
      };
      return { continue: true, context };
    }

    // BLOCK and PROMPT (which falls back to block in-process): short-circuit
    // with a non-zero result WITHOUT interpreting.
    const promptNote =
      policy === "prompt"
        ? " (prompt policy: no interactive prompt available in-process; treated as block)"
        : "";
    const blocked: BashExecResult = {
      stdout: "",
      stderr: `bash: blocked: destructive command refused: ${finding.command} ${finding.pattern} [${finding.code}]${promptNote}\n`,
      exitCode: BLOCK_EXIT_CODE,
      env: mapToRecordWithExtras(execState.env, options?.env),
      observations: [findingObservation(finding)],
    };
    return { continue: false, result: blocked };
  }
}
