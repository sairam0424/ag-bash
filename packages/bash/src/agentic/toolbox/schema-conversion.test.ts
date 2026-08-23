import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestBash } from "../../testing/createTestBash.js";
import { BashToolbox } from "./registry.js";
import { jsonSchemaToZod, zodToJsonSchema } from "./schema-conversion.js";

/**
 * The JSON Schema emitted here is the *only* description an LLM (or an MCP
 * client) receives when it constructs a tool call. If a parameter whose real
 * shape is `Array<{action, line, text}>` is advertised as `{type: "string"}`,
 * the model cannot produce a valid argument — the tool is uncallable even
 * though its Zod validator would happily accept the right shape.
 *
 * These tests pin the emitted schema for every Zod construct the ~62 registered
 * tools use (and the ones a future tool might use), plus the two real registered
 * tools whose parameters are arrays of objects: `ag_edit` and `ag_multi_edit`.
 */

/** Fetch a real registered tool's Zod schema straight out of the registry. */
function registeredParameters(name: string): z.ZodTypeAny {
  const tool = new BashToolbox().getTool(name);
  expect(tool, `tool '${name}' should be registered`).toBeDefined();
  if (!tool) throw new Error(`tool '${name}' not registered`);
  return tool.parameters as z.ZodTypeAny;
}

describe("zodToJsonSchema", () => {
  describe("primitives (must not regress)", () => {
    it("emits string/number/boolean with descriptions", () => {
      const out = zodToJsonSchema(
        z.object({
          path: z.string().describe("Absolute path."),
          count: z.number(),
          force: z.boolean().describe("Force it."),
        }),
      );

      expect(out).toEqual({
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path." },
          count: { type: "number" },
          force: { type: "boolean", description: "Force it." },
        },
        required: ["path", "count", "force"],
      });
    });

    it("emits an empty object schema for a tool with no parameters", () => {
      expect(zodToJsonSchema(z.object(Object.create(null)))).toEqual({
        type: "object",
        properties: Object.create(null),
        required: [],
      });
    });

    it("treats optional primitives as optional", () => {
      const out = zodToJsonSchema(
        z.object({
          required: z.string(),
          maybe: z.number().optional().describe("Optional number."),
        }),
      );

      expect(out.required).toEqual(["required"]);
      expect(out.properties.maybe).toEqual({
        type: "number",
        description: "Optional number.",
      });
    });
  });

  describe("enum", () => {
    it("emits the enum members", () => {
      const out = zodToJsonSchema(
        z.object({
          mode: z.enum(["fast", "slow"]).describe("Mode."),
        }),
      );

      expect(out.properties.mode).toEqual({
        type: "string",
        enum: ["fast", "slow"],
        description: "Mode.",
      });
    });

    it("emits the enum members through an optional wrapper", () => {
      const out = zodToJsonSchema(
        z.object({
          status: z.enum(["pending", "doing", "done"]).optional(),
        }),
      );

      expect(out.required).toEqual([]);
      expect(out.properties.status).toEqual({
        type: "string",
        enum: ["pending", "doing", "done"],
      });
    });
  });

  describe("literal", () => {
    it("emits a single-member enum for a string literal", () => {
      const out = zodToJsonSchema(z.object({ kind: z.literal("edit") }));
      expect(out.properties.kind).toEqual({ type: "string", enum: ["edit"] });
    });

    it("emits a number literal with the number type", () => {
      const out = zodToJsonSchema(z.object({ version: z.literal(2) }));
      expect(out.properties.version).toEqual({ type: "number", enum: [2] });
    });
  });

  describe("array", () => {
    it("describes an array of primitives with items", () => {
      const out = zodToJsonSchema(
        z.object({
          tags: z.array(z.string()).describe("Tag list."),
        }),
      );

      expect(out.properties.tags).toEqual({
        type: "array",
        items: { type: "string" },
        description: "Tag list.",
      });
    });

    it("describes an array of objects with the element's full shape", () => {
      const out = zodToJsonSchema(
        z.object({
          chunks: z
            .array(
              z.object({
                target: z.string().describe("Text to replace."),
                replacement: z.string(),
                occurrence: z.number().optional(),
              }),
            )
            .describe("Replacements."),
        }),
      );

      expect(out.properties.chunks).toEqual({
        type: "array",
        description: "Replacements.",
        items: {
          type: "object",
          properties: {
            target: { type: "string", description: "Text to replace." },
            replacement: { type: "string" },
            occurrence: { type: "number" },
          },
          required: ["target", "replacement"],
        },
      });
    });

    it("describes a nested array of arrays", () => {
      const out = zodToJsonSchema(
        z.object({ matrix: z.array(z.array(z.number())) }),
      );

      expect(out.properties.matrix).toEqual({
        type: "array",
        items: { type: "array", items: { type: "number" } },
      });
    });
  });

  describe("nested object", () => {
    it("recurses into the nested shape instead of flattening it", () => {
      const out = zodToJsonSchema(
        z.object({
          options: z
            .object({
              recursive: z.boolean(),
              depth: z.number().optional(),
            })
            .describe("Options."),
        }),
      );

      expect(out.properties.options).toEqual({
        type: "object",
        description: "Options.",
        properties: {
          recursive: { type: "boolean" },
          depth: { type: "number" },
        },
        required: ["recursive"],
      });
    });

    it("omits required on a nested object whose fields are all optional", () => {
      const out = zodToJsonSchema(
        z.object({ opts: z.object({ a: z.string().optional() }) }),
      );

      expect(out.properties.opts).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
      });
    });
  });

  describe("union", () => {
    it("emits anyOf over the union members", () => {
      const out = zodToJsonSchema(
        z.object({
          value: z.union([z.string(), z.number()]).describe("Either."),
        }),
      );

      expect(out.properties.value).toEqual({
        description: "Either.",
        anyOf: [{ type: "string" }, { type: "number" }],
      });
    });

    it("recurses into object members of a union", () => {
      const out = zodToJsonSchema(
        z.object({
          op: z.union([
            z.object({ kind: z.literal("add"), text: z.string() }),
            z.object({ kind: z.literal("del") }),
          ]),
        }),
      );

      expect(out.properties.op).toEqual({
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["add"] },
              text: { type: "string" },
            },
            required: ["kind", "text"],
          },
          {
            type: "object",
            properties: { kind: { type: "string", enum: ["del"] } },
            required: ["kind"],
          },
        ],
      });
    });
  });

  describe("record", () => {
    it("emits additionalProperties for the value type", () => {
      const out = zodToJsonSchema(
        z.object({
          env: z.record(z.string(), z.string()).describe("Env vars."),
        }),
      );

      expect(out.properties.env).toEqual({
        type: "object",
        description: "Env vars.",
        additionalProperties: { type: "string" },
      });
    });

    it("describes a record of objects", () => {
      const out = zodToJsonSchema(
        z.object({
          byName: z.record(z.string(), z.object({ id: z.number() })),
        }),
      );

      expect(out.properties.byName).toEqual({
        type: "object",
        additionalProperties: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
        },
      });
    });
  });

  describe("wrappers", () => {
    it("treats nullable as anyOf with null", () => {
      const out = zodToJsonSchema(
        z.object({ parent: z.string().nullable().describe("Parent or null.") }),
      );

      expect(out.required).toEqual(["parent"]);
      expect(out.properties.parent).toEqual({
        description: "Parent or null.",
        anyOf: [{ type: "string" }, { type: "null" }],
      });
    });

    it("treats a defaulted field as optional and records the default", () => {
      const out = zodToJsonSchema(
        z.object({ limit: z.number().default(10).describe("Max results.") }),
      );

      expect(out.required).toEqual([]);
      expect(out.properties.limit).toEqual({
        type: "number",
        description: "Max results.",
        default: 10,
      });
    });

    it("propagates a description attached before the optional wrapper", () => {
      const out = zodToJsonSchema(
        z.object({
          edits: z.array(z.string()).describe("Inner description.").optional(),
        }),
      );

      expect(out.properties.edits).toEqual({
        type: "array",
        items: { type: "string" },
        description: "Inner description.",
      });
    });

    it("prefers a description attached to the outer wrapper", () => {
      const out = zodToJsonSchema(
        z.object({
          edits: z.array(z.string()).optional().describe("Outer description."),
        }),
      );

      expect(out.properties.edits).toEqual({
        type: "array",
        items: { type: "string" },
        description: "Outer description.",
      });
    });

    it("unwraps optional(nullable(array))", () => {
      const out = zodToJsonSchema(
        z.object({ ids: z.array(z.number()).nullable().optional() }),
      );

      expect(out.required).toEqual([]);
      expect(out.properties.ids).toEqual({
        anyOf: [{ type: "array", items: { type: "number" } }, { type: "null" }],
      });
    });
  });

  describe("real registered tools", () => {
    it("describes ag_edit's true argument shape", () => {
      const out = zodToJsonSchema(registeredParameters("ag_edit"));

      expect(out).toEqual({
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute path to the file to edit.",
          },
          edits: {
            type: "array",
            description: "List of edits to apply sequentially.",
            items: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: [
                    "insert-before",
                    "insert-after",
                    "replace",
                    "delete",
                    "append",
                    "prepend",
                  ],
                },
                line: {
                  type: "number",
                  description: "Line number for the action.",
                },
                to: {
                  type: "number",
                  description: "End line number for 'replace' and 'delete'.",
                },
                text: {
                  type: "string",
                  description: "Text to insert or replace with.",
                },
              },
              required: ["action"],
            },
          },
          expectedHash: {
            type: "string",
            description:
              "The expected SHA-256 hash of the file content before applying edits. If it doesn't match, the edit will fail.",
          },
        },
        required: ["filePath", "edits"],
      });
    });

    it("describes ag_multi_edit's true argument shape", () => {
      const out = zodToJsonSchema(registeredParameters("ag_multi_edit"));

      expect(out).toEqual({
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file to edit.",
          },
          chunks: {
            type: "array",
            description: "List of replacement chunks.",
            items: {
              type: "object",
              properties: {
                target: {
                  type: "string",
                  description: "The exact text block to be replaced.",
                },
                replacement: {
                  type: "string",
                  description: "The new text to insert.",
                },
              },
              required: ["target", "replacement"],
            },
          },
        },
        required: ["path", "chunks"],
      });
    });

    it("advertises ag_todo's enum members so a model can pick one", () => {
      const out = zodToJsonSchema(registeredParameters("ag_todo"));

      expect(out.properties.operation).toEqual({
        type: "string",
        enum: ["list", "add", "update", "rm"],
        description: "The operation to perform.",
      });
      expect(out.properties.status?.enum).toEqual(["pending", "doing", "done"]);
      expect(out.required).toEqual(["operation"]);
    });

    it("never advertises a non-string parameter as a bare string", () => {
      const toolbox = new BashToolbox();
      const offenders: string[] = [];

      for (const tool of toolbox.getTools()) {
        const shape = (
          tool.parameters as unknown as {
            shape?: Record<string, z.ZodTypeAny>;
          }
        ).shape;
        if (!shape) continue;
        const emitted = zodToJsonSchema(tool.parameters as z.ZodTypeAny);
        for (const key of Object.keys(shape)) {
          const zodType = unwrapForProbe(shape[key]);
          const kind = (zodType as unknown as { _def: { type: string } })._def
            .type;
          const prop = emitted.properties[key];
          if (kind === "array" && prop?.type !== "array") {
            offenders.push(`${tool.name}.${key} (array -> ${prop?.type})`);
          }
          if (kind === "object" && prop?.type !== "object") {
            offenders.push(`${tool.name}.${key} (object -> ${prop?.type})`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });

    it("puts ag_edit's real shape on the wire via getAgenticTools", () => {
      // getAgenticTools is the single feed for BOTH consumer surfaces:
      // src/ai/core.ts (LLM adapters) and the MCP server's tool-bridge. Assert
      // on the JSON-serialized form, since that is what actually ships.
      const bash = createTestBash();
      const entry = new BashToolbox().getAgenticTools(bash).ag_edit;
      expect(entry).toBeDefined();

      const wire = JSON.parse(JSON.stringify(entry.inputSchema)) as {
        required: string[];
        properties: Record<string, { type?: string; items?: unknown }>;
      };

      expect(wire.required).toEqual(["filePath", "edits"]);
      expect(wire.properties.edits.type).toBe("array");
      expect(wire.properties.edits.items).toMatchObject({
        type: "object",
        required: ["action"],
      });
    });
  });
});

/** Strip optional/nullable/default wrappers for the registry-wide probe. */
function unwrapForProbe(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (let i = 0; i < 8; i++) {
    const def = (current as unknown as { _def: { type: string } })._def;
    if (
      def.type === "optional" ||
      def.type === "nullable" ||
      def.type === "default"
    ) {
      current = (current as unknown as { _def: { innerType: z.ZodTypeAny } })
        ._def.innerType;
      continue;
    }
    break;
  }
  return current;
}

describe("jsonSchemaToZod", () => {
  it("accepts an array argument declared by an MCP tool's inputSchema", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
      },
      required: ["paths"],
    });

    const parsed = schema.safeParse({ paths: ["/a", "/b"] });
    expect(parsed.success).toBe(true);
  });

  it("accepts a nested object argument declared by an MCP tool", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        options: {
          type: "object",
          properties: { deep: { type: "boolean" } },
          required: ["deep"],
        },
      },
      required: ["options"],
    });

    expect(schema.safeParse({ options: { deep: true } }).success).toBe(true);
  });

  it("still validates primitives and required-ness", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string", description: "Name." },
        age: { type: "number" },
        ok: { type: "boolean" },
      },
      required: ["name"],
    });

    expect(schema.safeParse({ name: "x" }).success).toBe(true);
    expect(schema.safeParse({ age: 1 }).success).toBe(false);
    expect(schema.safeParse({ name: 1 }).success).toBe(false);
  });

  it("round-trips an array-of-objects schema back through zodToJsonSchema", () => {
    const original = zodToJsonSchema(registeredParameters("ag_multi_edit"));
    const roundTripped = zodToJsonSchema(jsonSchemaToZod(original));

    expect(roundTripped.properties.chunks?.type).toBe("array");
    expect(roundTripped.properties.chunks?.items?.type).toBe("object");
    expect(roundTripped.required).toEqual(["path", "chunks"]);
  });
});
