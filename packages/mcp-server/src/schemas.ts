import { z } from "zod";

/**
 * Zod schemas for validating snapshot and delta payloads
 * before passing them to the Bash engine. This prevents
 * deserialization attacks via malformed JSON inputs.
 *
 * These schemas validate structural integrity and size bounds
 * without being overly strict about the internal InterpreterState
 * shape (which uses Maps that serialize to objects).
 */

const MAX_KEY_LENGTH = 1024;
const MAX_VALUE_LENGTH = 1_048_576; // 1MB per value
const MAX_ENTRIES = 10_000;
const MAX_PATH_LENGTH = 4096;

/** Bounded string record: keys and values both length-limited */
const boundedStringRecord = z.record(
  z.string().max(MAX_KEY_LENGTH),
  z.string().max(MAX_VALUE_LENGTH),
).refine(
  (obj) => Object.keys(obj).length <= MAX_ENTRIES,
  { message: `Record exceeds maximum of ${MAX_ENTRIES} entries` },
);

/**
 * Full snapshot schema — validated before restore operations.
 *
 * BashSnapshot is `{ state: InterpreterState; fs: unknown }`.
 * InterpreterState contains Maps (serialized as objects), strings, numbers, etc.
 * We validate the top-level shape and critical fields without
 * requiring every internal field (the engine handles that).
 */
export const BashSnapshotSchema = z.object({
  state: z.object({
    env: z.unknown(), // Map<string, string> serialized as object or array
    cwd: z.string().min(1).max(MAX_PATH_LENGTH),
    previousDir: z.string().max(MAX_PATH_LENGTH).optional(),
    lastExitCode: z.number().int().optional(),
    functions: z.unknown().optional(), // Map<string, FunctionDefNode>
  }).passthrough(), // Allow additional InterpreterState fields
  fs: z.unknown(), // Filesystem snapshot (opaque)
});

/**
 * State delta schema — validated before applyDelta operations.
 *
 * BashDelta is:
 * {
 *   envDelta?: Record<string, string | null>;
 *   funcDelta?: Record<string, string | null>;
 *   fsDelta?: { modified: Record<string, string|Uint8Array>; deleted: string[] };
 *   cwd?: string;
 * }
 */
export const StateDeltaSchema = z.object({
  envDelta: z.record(
    z.string().max(MAX_KEY_LENGTH),
    z.union([z.string().max(MAX_VALUE_LENGTH), z.null()]),
  ).refine(
    (obj) => Object.keys(obj).length <= MAX_ENTRIES,
    { message: `envDelta exceeds maximum of ${MAX_ENTRIES} entries` },
  ).optional(),
  funcDelta: z.record(
    z.string().max(MAX_KEY_LENGTH),
    z.union([z.string().max(MAX_VALUE_LENGTH), z.null()]),
  ).refine(
    (obj) => Object.keys(obj).length <= MAX_ENTRIES,
    { message: `funcDelta exceeds maximum of ${MAX_ENTRIES} entries` },
  ).optional(),
  fsDelta: z.object({
    modified: z.record(
      z.string().max(MAX_PATH_LENGTH),
      z.unknown(), // string or Uint8Array serialized
    ).refine(
      (obj) => Object.keys(obj).length <= MAX_ENTRIES,
      { message: `fsDelta.modified exceeds maximum of ${MAX_ENTRIES} entries` },
    ),
    deleted: z.array(z.string().max(MAX_PATH_LENGTH)).max(MAX_ENTRIES),
  }).optional(),
  cwd: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
});

export type BashSnapshot = z.infer<typeof BashSnapshotSchema>;
export type StateDelta = z.infer<typeof StateDeltaSchema>;

/**
 * Validate a snapshot payload. Throws a descriptive error on invalid input.
 */
export function validateSnapshot(data: unknown): BashSnapshot {
  const result = BashSnapshotSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid snapshot payload: ${issues}`);
  }
  return result.data;
}

/**
 * Validate a delta payload. Throws a descriptive error on invalid input.
 */
export function validateDelta(data: unknown): StateDelta {
  const result = StateDeltaSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid delta payload: ${issues}`);
  }
  return result.data;
}
