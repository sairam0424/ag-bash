/**
 * Schema Conversion Utilities
 *
 * Converts between Zod schemas and JSON Schema format for MCP tool integration
 * and AI SDK interoperability.
 */

import { z } from "zod";

/**
 * Minimal JSON Schema interface for MCP tool input schemas.
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
}

/**
 * JSON Schema output shape from zodToJsonSchema.
 */
export interface JsonSchemaOutput {
  type: "object";
  properties: Record<string, JsonSchemaPropertyOutput>;
  required: string[];
}

export interface JsonSchemaPropertyOutput {
  type: string;
  description?: string;
  enum?: string[];
}

/**
 * Lightweight Zod to JSON Schema converter.
 *
 * Accesses Zod internal `shape` and `_def` properties which lack public type
 * declarations. We use `unknown` with narrowing where possible and explicit
 * interface casts for Zod internals that have no public API surface.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchemaOutput {
  // ZodObject exposes `.shape` but it is not part of ZodTypeAny's public type.
  // We access it through a typed interface that reflects the runtime structure.
  interface ZodObjectLike {
    shape: Record<string, z.ZodTypeAny>;
  }
  const objectSchema = schema as unknown as ZodObjectLike;
  const shape: Record<string, z.ZodTypeAny> =
    objectSchema.shape ?? (Object.create(null) as Record<string, z.ZodTypeAny>);
  const properties: Record<string, JsonSchemaPropertyOutput> =
    Object.create(null);
  const required: string[] = [];

  for (const key of Object.keys(shape)) {
    const field = shape[key];
    const desc: string | undefined = field.description;

    let type = "string";
    let enumValues: string[] | undefined;

    if (field instanceof z.ZodString) {
      type = "string";
    } else if (field instanceof z.ZodNumber) {
      type = "number";
    } else if (field instanceof z.ZodBoolean) {
      type = "boolean";
    } else if (field instanceof z.ZodEnum) {
      type = "string";
      // ZodEnum stores values in _def.values (string[] at runtime)
      interface ZodEnumDef {
        _def: { values: string[] };
      }
      enumValues = (field as unknown as ZodEnumDef)._def.values;
    } else if (field instanceof z.ZodOptional) {
      // Handle optional fields - unwrap to get inner type
      interface ZodOptionalDef {
        _def: { innerType: z.ZodTypeAny };
      }
      const inner = (field as unknown as ZodOptionalDef)._def.innerType;
      if (inner instanceof z.ZodString) type = "string";
      else if (inner instanceof z.ZodNumber) type = "number";
      else if (inner instanceof z.ZodBoolean) type = "boolean";
      else if (inner instanceof z.ZodEnum) {
        type = "string";
        interface ZodEnumDef {
          _def: { values: string[] };
        }
        enumValues = (inner as unknown as ZodEnumDef)._def.values;
      }
    }

    const prop: JsonSchemaPropertyOutput = { type };
    if (desc) prop.description = desc;
    if (enumValues) prop.enum = enumValues;
    properties[key] = prop;

    if (!(field instanceof z.ZodOptional)) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required,
  };
}

/**
 * Simple JSON Schema to Zod converter for MCP tools.
 */
export function jsonSchemaToZod(
  schema: JsonSchema | undefined,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = Object.create(null);
  const props =
    schema?.properties ??
    (Object.create(null) as Record<string, JsonSchemaProperty>);
  const requiredFields = schema?.required ?? [];
  for (const key of Object.keys(props)) {
    const prop = props[key];
    let zType: z.ZodTypeAny = z.string();
    if (prop.type === "number") zType = z.number();
    else if (prop.type === "boolean") zType = z.boolean();

    if (prop.description) zType = zType.describe(prop.description);
    if (!requiredFields.includes(key)) {
      zType = zType.optional();
    }
    shape[key] = zType;
  }
  return z.object(shape);
}
