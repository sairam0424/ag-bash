/**
 * Schema Conversion Utilities
 *
 * Converts between Zod schemas and JSON Schema format for MCP tool integration
 * and AI SDK interoperability.
 *
 * The emitted JSON Schema is the *only* description of a tool's arguments that
 * an LLM (or an MCP client) ever sees, so a converter that collapses composite
 * types makes those tools uncallable: a model told that `edits` is a `string`
 * cannot construct the `Array<{action, line, text}>` the tool actually needs.
 * Both directions therefore recurse through composite types.
 *
 * Dispatch is on Zod's internal `_def.type` discriminant rather than
 * `instanceof`, for two reasons:
 *  1. `instanceof` breaks across duplicate copies of the `zod` module (a real
 *     hazard in a pnpm workspace where mcp-server and bash each resolve zod),
 *     and every miss degrades silently to the fallback branch.
 *  2. Zod 4 string/number *formats* are not subclasses of the base class —
 *     `z.email() instanceof z.ZodString` is `false`, while its `_def.type` is
 *     still `"string"`.
 *
 * Zod 4 conforms to Standard Schema natively; migrating to that interface is a
 * separate, later change. Nothing here reaches into Zod beyond the narrow
 * `_def` reads collected in `zodDefOf`/`zodShapeOf`/`zodEnumValuesOf`, so that
 * migration only has to replace those three helpers.
 */

import { z } from "zod";

/**
 * Guard against unbounded recursion (self-referential or pathologically deep
 * schemas). Beyond this depth a node is emitted as the empty schema, which in
 * JSON Schema means "anything" — permissive, but never wrong.
 */
const MAX_SCHEMA_DEPTH = 12;

/**
 * Minimal JSON Schema interface for MCP tool input schemas.
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * A JSON Schema node as accepted on input (from an MCP tool descriptor).
 * Recursive: composite nodes carry their element/member/property schemas.
 */
export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: readonly (string | number | boolean | null)[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  anyOf?: readonly JsonSchemaProperty[];
  additionalProperties?: JsonSchemaProperty | boolean;
}

/**
 * JSON Schema output shape from zodToJsonSchema.
 */
export interface JsonSchemaOutput {
  type: "object";
  properties: Record<string, JsonSchemaPropertyOutput>;
  required: string[];
}

/**
 * A JSON Schema node as emitted by zodToJsonSchema.
 *
 * `type` is optional because a union (or a nullable) is emitted as `anyOf`,
 * which carries no single top-level `type`.
 */
export interface JsonSchemaPropertyOutput {
  type?: string;
  description?: string;
  enum?: (string | number | boolean | null)[];
  items?: JsonSchemaPropertyOutput;
  properties?: Record<string, JsonSchemaPropertyOutput>;
  required?: string[];
  anyOf?: JsonSchemaPropertyOutput[];
  additionalProperties?: JsonSchemaPropertyOutput;
  default?: string | number | boolean | null;
}

/**
 * The subset of Zod's internal definition object this converter reads.
 * Zod does not expose these through a public typed API.
 */
interface ZodDefLike {
  type: string;
  innerType?: z.ZodTypeAny;
  element?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
  values?: readonly unknown[];
  defaultValue?: unknown;
  in?: z.ZodTypeAny;
}

/** Read Zod's internal `_def` (the type discriminant plus child schemas). */
function zodDefOf(schema: z.ZodTypeAny): ZodDefLike {
  const withDef = schema as unknown as { _def?: ZodDefLike };
  return withDef._def ?? { type: "unknown" };
}

/** Read a ZodObject's `shape`, which is absent on every other Zod type. */
function zodShapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  const withShape = schema as unknown as {
    shape?: Record<string, z.ZodTypeAny>;
  };
  return (
    withShape.shape ?? (Object.create(null) as Record<string, z.ZodTypeAny>)
  );
}

/**
 * Read a ZodEnum's members. Zod 4 stores them in `_def.entries` (an object,
 * not the `_def.values` array Zod 3 used) and exposes the flat list through the
 * public `.options` getter, which is preferred where present.
 */
function zodEnumValuesOf(schema: z.ZodTypeAny): (string | number)[] {
  const enumLike = schema as unknown as {
    options?: readonly (string | number)[];
    _def?: { entries?: Record<string, string | number> };
  };
  if (Array.isArray(enumLike.options)) return [...enumLike.options];
  const entries = enumLike._def?.entries;
  if (entries) return Object.values(entries);
  return [];
}

/** The empty JSON Schema — matches any value. */
function anySchemaNode(): JsonSchemaPropertyOutput {
  return Object.create(null) as JsonSchemaPropertyOutput;
}

/** JSON Schema type name for a literal value, or undefined if unmappable. */
function jsonTypeOfLiteral(value: unknown): string | undefined {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value === null) return "null";
  return undefined;
}

/** Narrow a value to something representable as a JSON Schema constant. */
function asJsonConstant(
  value: unknown,
): string | number | boolean | null | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  return undefined;
}

/** A field's converted schema plus whether the caller may omit it. */
interface ConvertedField {
  node: JsonSchemaPropertyOutput;
  optional: boolean;
}

/**
 * Convert one Zod type (including its optional/nullable/default wrappers)
 * into a JSON Schema node.
 */
function convertField(schema: z.ZodTypeAny, depth: number): ConvertedField {
  if (depth > MAX_SCHEMA_DEPTH) {
    return { node: anySchemaNode(), optional: false };
  }

  let current = schema;
  let optional = false;
  let nullable = false;
  let description: string | undefined;
  let defaultValue: string | number | boolean | null | undefined;

  // Peel wrapper types. The outermost `.describe()` wins; if only an inner type
  // was described (`z.array(...).describe(x).optional()`), that description is
  // still surfaced rather than lost.
  for (let i = 0; i < MAX_SCHEMA_DEPTH; i++) {
    if (description === undefined) description = current.description;
    const def = zodDefOf(current);
    const isWrapper =
      def.type === "optional" ||
      def.type === "default" ||
      def.type === "prefault" ||
      def.type === "nullable" ||
      def.type === "readonly" ||
      def.type === "catch";
    if (!isWrapper || !def.innerType) break;

    if (def.type === "optional") optional = true;
    if (def.type === "default" || def.type === "prefault") {
      // A defaulted field is one the caller may omit; JSON Schema expresses
      // that as "not required", not as a distinct type.
      optional = true;
      defaultValue = asJsonConstant(def.defaultValue);
    }
    if (def.type === "nullable") nullable = true;
    current = def.innerType;
  }

  let node = convertBase(current, depth);
  if (nullable) node = { anyOf: [node, { type: "null" }] };
  if (description !== undefined) node = { ...node, description };
  if (defaultValue !== undefined) node = { ...node, default: defaultValue };

  return { node, optional };
}

/** Convert an already-unwrapped Zod type into a JSON Schema node. */
function convertBase(
  schema: z.ZodTypeAny,
  depth: number,
): JsonSchemaPropertyOutput {
  const def = zodDefOf(schema);

  switch (def.type) {
    case "string":
    case "date":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "bigint":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };

    case "enum": {
      const values = zodEnumValuesOf(schema);
      const node: JsonSchemaPropertyOutput = { type: "string", enum: values };
      const first = values.length > 0 ? values[0] : undefined;
      // A Zod enum built from a numeric TS enum yields number members.
      if (typeof first === "number") return { ...node, type: "number" };
      return node;
    }

    case "literal": {
      const values = (def.values ?? []).map(asJsonConstant);
      const known = values.filter((value) => value !== undefined);
      if (known.length === 0) return anySchemaNode();
      const types = new Set(known.map(jsonTypeOfLiteral));
      const node: JsonSchemaPropertyOutput = { enum: known };
      if (types.size === 1) {
        const only = known.length > 0 ? jsonTypeOfLiteral(known[0]) : undefined;
        if (only) return { ...node, type: only };
      }
      return node;
    }

    case "array":
      return {
        type: "array",
        items: def.element
          ? convertField(def.element, depth + 1).node
          : anySchemaNode(),
      };

    case "object":
      return convertObject(schema, depth);

    case "union": {
      const options = def.options ?? [];
      if (options.length === 0) return anySchemaNode();
      return {
        anyOf: options.map((option) => convertField(option, depth + 1).node),
      };
    }

    case "record":
    case "map":
      return {
        type: "object",
        additionalProperties: def.valueType
          ? convertField(def.valueType, depth + 1).node
          : anySchemaNode(),
      };

    // `.transform()` / `z.stringbool()` produce a pipe; the input side is what
    // a caller must supply, so that is what gets advertised.
    case "pipe":
      return def.in ? convertBase(def.in, depth + 1) : anySchemaNode();

    // Everything else (any/unknown/tuple/intersection/lazy/...) is advertised
    // as the empty schema: honest about being unconstrained, rather than
    // claiming a wrong concrete type.
    default:
      return anySchemaNode();
  }
}

/** Convert a ZodObject into an object-typed JSON Schema node. */
function convertObject(
  schema: z.ZodTypeAny,
  depth: number,
): JsonSchemaPropertyOutput {
  const shape = zodShapeOf(schema);
  const properties: Record<string, JsonSchemaPropertyOutput> =
    Object.create(null);
  const required: string[] = [];

  for (const key of Object.keys(shape)) {
    const converted = convertField(shape[key], depth + 1);
    properties[key] = converted.node;
    if (!converted.optional) required.push(key);
  }

  const node: JsonSchemaPropertyOutput = { type: "object", properties };
  if (required.length > 0) return { ...node, required };
  return node;
}

/**
 * Convert a Zod object schema into the JSON Schema an LLM or MCP client is
 * given to build a tool call.
 *
 * Composite types are described in full: arrays carry `items`, nested objects
 * carry `properties`/`required`, unions become `anyOf`, records become
 * `additionalProperties`, and enums/literals carry their `enum` members.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchemaOutput {
  const shape = zodShapeOf(schema);
  const properties: Record<string, JsonSchemaPropertyOutput> =
    Object.create(null);
  const required: string[] = [];

  for (const key of Object.keys(shape)) {
    const converted = convertField(shape[key], 1);
    properties[key] = converted.node;
    if (!converted.optional) required.push(key);
  }

  // `required` is always present (possibly empty) — consumers read `.length`.
  return {
    type: "object",
    properties,
    required,
  };
}

/**
 * Convert a JSON Schema node from an MCP tool descriptor into a Zod type.
 *
 * Unrecognised nodes become `z.unknown()` rather than `z.string()`: this
 * validator gates real tool calls, so guessing a concrete type rejects
 * arguments the remote tool would have accepted.
 */
function zodFromJsonSchemaNode(
  prop: JsonSchemaProperty,
  depth: number,
): z.ZodTypeAny {
  if (depth > MAX_SCHEMA_DEPTH) return z.unknown();

  if (prop.anyOf && prop.anyOf.length > 0) {
    const options = prop.anyOf.map((member) =>
      zodFromJsonSchemaNode(member, depth + 1),
    );
    const first = options[0];
    if (options.length === 1 && first) return first;
    return z.union(options);
  }

  switch (prop.type) {
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "string":
      return z.string();
    case "array":
      return z.array(
        prop.items ? zodFromJsonSchemaNode(prop.items, depth + 1) : z.unknown(),
      );
    case "object": {
      if (prop.properties) return zodObjectFromJsonSchema(prop, depth + 1);
      const additional = prop.additionalProperties;
      const valueType =
        additional && typeof additional === "object"
          ? zodFromJsonSchemaNode(additional, depth + 1)
          : z.unknown();
      return z.record(z.string(), valueType);
    }
    default:
      return z.unknown();
  }
}

/** Build a ZodObject from a JSON Schema object node. */
function zodObjectFromJsonSchema(
  schema: JsonSchemaProperty | undefined,
  depth: number,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = Object.create(null);
  const props =
    schema?.properties ??
    (Object.create(null) as Record<string, JsonSchemaProperty>);
  const requiredFields = schema?.required ?? [];

  for (const key of Object.keys(props)) {
    const prop = props[key];
    let zType: z.ZodTypeAny = zodFromJsonSchemaNode(prop, depth + 1);

    if (prop.description) zType = zType.describe(prop.description);
    if (!requiredFields.includes(key)) {
      zType = zType.optional();
    }
    shape[key] = zType;
  }

  return z.object(shape);
}

/**
 * Simple JSON Schema to Zod converter for MCP tools.
 */
export function jsonSchemaToZod(
  schema: JsonSchema | undefined,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  return zodObjectFromJsonSchema(schema, 0);
}
