import { z } from "zod";

/**
 * MCP `outputSchema` derivation (protocol 2025-06-18).
 *
 * The MCP 2025-06-18 revision lets a tool advertise an `outputSchema` (JSON
 * Schema) describing the shape of the `structuredContent` it returns. This
 * module owns:
 *  - a small, self-contained Zod -> JSON Schema converter (mcp-server already
 *    depends on zod), and
 *  - the canonical output Zod schemas for every native MCP tool.
 *
 * We keep the converter local to mcp-server rather than reaching into the bash
 * package internals: the bash `zodToJsonSchema` helper is not part of the
 * `@ag-bash/bash` public export surface, and the native tool outputs are
 * defined here anyway. The converter handles the field types the native tool
 * outputs actually use (string/number/boolean/enum/array/object/optional).
 */

/** A JSON Schema node, modelled with a null-prototype-friendly shape. */
export interface JsonSchemaNode {
  type?: string;
  description?: string;
  enum?: readonly string[];
  items?: JsonSchemaNode;
  properties?: Map<string, JsonSchemaNode>;
  required?: readonly string[];
}

/**
 * Serializable JSON Schema (plain object form) as sent over the wire. `Map`s
 * are converted to null-prototype objects only at serialization time so the
 * in-memory representation stays mutation-discouraged via `Map`.
 */
export interface JsonSchemaWire {
  type: string;
  properties: Record<string, unknown>;
  required?: string[];
}

/** Unwrap optional/default/nullable wrappers, returning the inner Zod type. */
function unwrap(schema: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  optional: boolean;
} {
  let current: z.ZodTypeAny = schema;
  let optional = false;
  // Bounded loop: at most a handful of nested wrappers in practice.
  for (let i = 0; i < 8; i++) {
    if (current instanceof z.ZodOptional) {
      optional = true;
      current = (current as unknown as { unwrap: () => z.ZodTypeAny }).unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault) {
      optional = true;
      const def = (current as unknown as { _def: { innerType: z.ZodTypeAny } })
        ._def;
      current = def.innerType;
      continue;
    }
    if (current instanceof z.ZodNullable) {
      current = (current as unknown as { unwrap: () => z.ZodTypeAny }).unwrap();
      continue;
    }
    break;
  }
  return { inner: current, optional };
}

/** Convert a single (already-unwrapped) Zod node into a JSON Schema node. */
function nodeFromZod(schema: z.ZodTypeAny): JsonSchemaNode {
  const description: string | undefined = schema.description;
  const base = (node: JsonSchemaNode): JsonSchemaNode =>
    description ? { ...node, description } : node;

  if (schema instanceof z.ZodString) return base({ type: "string" });
  if (schema instanceof z.ZodNumber) return base({ type: "number" });
  if (schema instanceof z.ZodBoolean) return base({ type: "boolean" });

  if (schema instanceof z.ZodEnum) {
    const values = (schema as unknown as { _def: { values: string[] } })._def
      .values;
    return base({ type: "string", enum: [...values] });
  }

  if (schema instanceof z.ZodArray) {
    const element = (schema as unknown as { element: z.ZodTypeAny }).element;
    const { inner } = unwrap(element);
    return base({ type: "array", items: nodeFromZod(inner) });
  }

  if (schema instanceof z.ZodObject) {
    return base(objectNodeFromZod(schema));
  }

  // Fallback: unknown/any/record -> generic object.
  return base({ type: "object" });
}

/** Convert a Zod object schema into an object-typed JSON Schema node. */
function objectNodeFromZod(schema: z.ZodTypeAny): JsonSchemaNode {
  const shape =
    (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape ??
    (Object.create(null) as Record<string, z.ZodTypeAny>);

  const properties = new Map<string, JsonSchemaNode>();
  const required: string[] = [];

  for (const key of Object.keys(shape)) {
    const { inner, optional } = unwrap(shape[key]);
    properties.set(key, nodeFromZod(inner));
    if (!optional) required.push(key);
  }

  return { type: "object", properties, required };
}

/** Serialize a JSON Schema node into the plain-object wire form. */
function serializeNode(node: JsonSchemaNode): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  if (node.type) out.type = node.type;
  if (node.description) out.description = node.description;
  if (node.enum) out.enum = [...node.enum];
  if (node.items) out.items = serializeNode(node.items);
  if (node.properties) {
    const props: Record<string, unknown> = Object.create(null);
    for (const [key, value] of node.properties) {
      props[key] = serializeNode(value);
    }
    out.properties = props;
  }
  if (node.required && node.required.length > 0)
    out.required = [...node.required];
  return out;
}

/**
 * Convert a Zod object schema to the MCP `outputSchema` wire form
 * (`{ type: "object", properties, required }`).
 */
export function toOutputSchema(schema: z.ZodTypeAny): JsonSchemaWire {
  const node = objectNodeFromZod(schema);
  const properties: Record<string, unknown> = Object.create(null);
  if (node.properties) {
    for (const [key, value] of node.properties) {
      properties[key] = serializeNode(value);
    }
  }
  const wire: JsonSchemaWire = {
    type: "object",
    properties,
  };
  if (node.required && node.required.length > 0) {
    wire.required = [...node.required];
  }
  return wire;
}

/* ------------------------------------------------------------------ */
/*  Canonical output schemas for native MCP tools                     */
/* ------------------------------------------------------------------ */

/** `run_bash` structured output. */
export const RunBashOutput: z.ZodObject<{
  stdout: z.ZodString;
  stderr: z.ZodString;
  exitCode: z.ZodNumber;
}> = z.object({
  stdout: z.string().describe("Standard output captured from the script."),
  stderr: z.string().describe("Standard error captured from the script."),
  exitCode: z.number().describe("Process exit code (0 = success)."),
});

/** `get_state` structured output. */
export const GetStateOutput: z.ZodObject<{
  cwd: z.ZodString;
  env: z.ZodRecord<z.ZodString, z.ZodString>;
}> = z.object({
  cwd: z.string().describe("Current working directory of the shell."),
  env: z.record(z.string(), z.string()).describe("Environment variables."),
});

/** `snapshot` / `create_delta` structured output (opaque base64 blob). */
export const EncodedBlobOutput: z.ZodObject<{
  encoded: z.ZodString;
}> = z.object({
  encoded: z.string().describe("Base64-encoded opaque state blob."),
});

/** Acknowledgement-only structured output (restore / apply_delta). */
export const AckOutput: z.ZodObject<{
  ok: z.ZodBoolean;
  message: z.ZodString;
}> = z.object({
  ok: z.boolean().describe("Whether the operation succeeded."),
  message: z.string().describe("Human-readable status message."),
});

/** A single fork_speculate branch result. */
const BranchResultSchema = z.object({
  index: z.number().describe("0-based branch index."),
  exitCode: z.number().describe("Final exit code for the branch."),
  stdout: z.string().describe("Combined stdout for the branch."),
  stderr: z.string().describe("Combined stderr for the branch."),
});

/** `fork_speculate` structured output. */
export const ForkSpeculateOutput: z.ZodObject<{
  branches: z.ZodArray<typeof BranchResultSchema>;
  committed: z.ZodNullable<z.ZodNumber>;
}> = z.object({
  branches: z.array(BranchResultSchema).describe("Per-branch results."),
  committed: z
    .number()
    .nullable()
    .describe("Index of the committed branch, or null if none."),
});

/** A single search_tools match. */
const ToolMatchSchema = z.object({
  name: z.string().describe("Tool name."),
  description: z.string().describe("Tool description."),
});

/** `search_tools` structured output. */
export const SearchToolsOutput: z.ZodObject<{
  query: z.ZodString;
  matches: z.ZodArray<typeof ToolMatchSchema>;
}> = z.object({
  query: z.string().describe("The query that was searched."),
  matches: z.array(ToolMatchSchema).describe("Matching tools, best first."),
});
