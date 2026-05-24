/**
 * Shared types for all AI framework adapters.
 *
 * These types define the common interface that all adapters consume,
 * as well as the output shapes for each supported framework.
 */

/**
 * JSON Schema representation (subset used for tool parameter definitions).
 */
export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema & { description?: string }>;
  required?: readonly string[];
  description?: string;
  items?: JSONSchema;
  enum?: readonly string[];
  additionalProperties?: boolean | JSONSchema;
}

/**
 * Result returned from executing a bash tool call.
 */
export interface ToolExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Error result returned when execution fails.
 */
export interface ToolExecutionError {
  error: string;
  exitCode: number;
}

/**
 * Union of possible execution outcomes.
 */
export type ToolResult = ToolExecutionResult | ToolExecutionError;

/**
 * A single tool definition with its execution logic.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

// --- Framework-specific output types ---

/**
 * OpenAI function calling format.
 */
export interface OpenAIToolSet {
  tools: Array<{
    type: "function";
    function: { name: string; description: string; parameters: JSONSchema };
  }>;
  handleToolCall(name: string, args: string): Promise<string>;
}

/**
 * Anthropic tool_use format.
 */
export interface AnthropicToolSet {
  tools: Array<{
    name: string;
    description: string;
    input_schema: JSONSchema;
  }>;
  handleToolUse(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ content: string }>;
}

/**
 * LangChain DynamicStructuredTool-compatible format.
 */
export interface LangChainToolDef {
  name: string;
  description: string;
  schema: {
    parse: (input: unknown) => Record<string, unknown>;
    _def: { typeName: string };
  };
  func: (input: Record<string, unknown>) => Promise<string>;
}

export interface LangChainToolSet {
  tools: LangChainToolDef[];
}

/**
 * Vercel AI SDK format.
 */
export interface VercelToolSet {
  tools: Record<
    string,
    {
      description: string;
      inputSchema: JSONSchema;
      parameters: JSONSchema;
      execute: (args: Record<string, unknown>) => Promise<ToolResult>;
    }
  >;
}

/**
 * Generic framework-agnostic format.
 */
export interface GenericToolSet {
  tools: ToolDefinition[];
  handleCall(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}
