import { Ajv, type ValidateFunction } from "ajv";
import { isDeepStrictEqual } from "node:util";
import { ConfigError, errorMessage } from "../errors.js";

export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: string };

const CODE_FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i;

/**
 * Parses model output as JSON. A single surrounding markdown code fence is
 * tolerated because models add one often enough that failing on it would
 * make most JSON checks noisy; anything else must be pure JSON.
 */
export function parseJsonOutput(output: string): JsonParseResult {
  const trimmed = output.trim();
  const fenced = CODE_FENCE.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch (error) {
    return { ok: false, error: `output is not valid JSON (${errorMessage(error)})` };
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new WeakMap<Record<string, unknown>, ValidateFunction>();

/** Compiles (and caches) a JSON Schema. Throws ConfigError on an invalid schema. */
export function compileJsonSchema(schema: Record<string, unknown>, where: string): ValidateFunction {
  const cached = compiled.get(schema);
  if (cached) return cached;
  try {
    const validate = ajv.compile(schema);
    compiled.set(schema, validate);
    return validate;
  } catch (error) {
    throw new ConfigError(`${where}: invalid JSON Schema (${errorMessage(error)})`, { cause: error });
  }
}

/** Validates a value; returns a readable list of violations (empty = valid). */
export function schemaViolations(validate: ValidateFunction, value: unknown): string[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
}

/**
 * Resolves a dotted path such as `ticket.tags.0` against a parsed JSON value.
 * Returns `found: false` if any segment is missing.
 */
export function getJsonPath(value: unknown, path: string): { found: boolean; value: unknown } {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false, value: undefined };
      current = current[index];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

export function jsonEquals(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}
