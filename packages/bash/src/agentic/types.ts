import type { ExecResult } from "../types.js";

/**
 * Interface for LLM-based troubleshooting.
 * Allows the host environment to provide AI-powered diagnostics.
 */
export interface LLMProvider {
  /**
   * Generates a diagnostic suggestion based on the failure context.
   */
  generateSuggestion(context: string): Promise<string | null>;
}

/**
 * Configuration for the Agentic Healer.
 */
export interface AgenticHealerConfig {
  /**
   * If true, enables heuristic-based local diagnostics.
   * Default: true
   */
  enableHeuristics?: boolean;
  /**
   * Optional LLM provider for advanced troubleshooting.
   */
  llm?: LLMProvider;
  /**
   * If true, the healer may attempt to automatically fix and re-run simple typos.
   * Default: false
   */
  allowAutoFix?: boolean;
}
