/**
 * LangChain DynamicStructuredTool adapter.
 *
 * Converts ToolDefinition[] into objects compatible with LangChain's
 * DynamicStructuredTool shape (name, description, schema, func).
 *
 * NOTE: This does NOT import @langchain/core — it produces plain objects
 * matching the expected shape so consumers can pass them directly.
 * The schema is a minimal Zod-like object with a parse() method.
 */

import type {
  LangChainToolDef,
  LangChainToolSet,
  ToolDefinition,
  ToolResult,
} from "../types.js";

/**
 * Create a minimal Zod-like schema object from a JSON Schema definition.
 * This provides a `parse()` method that validates the `command` property
 * and a `_def` marker so LangChain recognizes it as a ZodObject.
 */
function createMinimalSchema(
  inputSchema: ToolDefinition["inputSchema"],
): LangChainToolDef["schema"] {
  const requiredFields = inputSchema.required ?? [];
  const properties = inputSchema.properties ?? Object.create(null);

  return {
    _def: { typeName: "ZodObject" },
    parse(input: unknown): Record<string, unknown> {
      if (typeof input !== "object" || input === null) {
        throw new Error("Input must be an object");
      }

      const record = input as Record<string, unknown>;

      for (const field of requiredFields) {
        if (!(field in record)) {
          throw new Error(`Missing required field: ${field}`);
        }
      }

      // Validate string types
      for (const [key, prop] of Object.entries(properties) as [
        string,
        { type?: string },
      ][]) {
        if (
          key in record &&
          prop.type === "string" &&
          typeof record[key] !== "string"
        ) {
          throw new Error(`Field "${key}" must be a string`);
        }
      }

      return record;
    },
  };
}

/**
 * Serialize a ToolResult to a string for LangChain's func return value.
 */
function resultToString(result: ToolResult): string {
  return JSON.stringify(result);
}

/**
 * Transform tool definitions into LangChain DynamicStructuredTool format.
 */
export function toLangChain(definitions: ToolDefinition[]): LangChainToolSet {
  const tools: LangChainToolDef[] = definitions.map((def) => ({
    name: def.name,
    description: def.description,
    schema: createMinimalSchema(def.inputSchema),
    func: async (input: Record<string, unknown>): Promise<string> => {
      const result: ToolResult = await def.execute(input);
      return resultToString(result);
    },
  }));

  return { tools };
}
