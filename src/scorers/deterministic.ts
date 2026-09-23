import type { Expectation, ScoreResult } from "../types.js";
import { compileJsonSchema, getJsonPath, jsonEquals, parseJsonOutput, schemaViolations } from "./json.js";

type Of<T extends Expectation["type"]> = Extract<Expectation, { type: T }>;

/** Longest excerpt of model output quoted back in a failure reason. */
const EXCERPT_LIMIT = 120;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LIMIT ? `${flat.slice(0, EXCERPT_LIMIT)}...` : flat;
}

function result(e: Expectation, defaultLabel: string, pass: boolean, reason: string): ScoreResult {
  return { type: e.type, label: e.label ?? defaultLabel, pass, reason };
}

export function scoreExact(e: Of<"exact">, output: string): ScoreResult {
  const norm = (s: string): string => {
    const t = e.trim ? s.trim() : s;
    return e.ignoreCase ? t.toLowerCase() : t;
  };
  const pass = norm(output) === norm(e.value);
  return result(e, `exact "${excerpt(e.value)}"`, pass, pass ? "matched" : `got "${excerpt(output)}"`);
}

export function scoreRegex(e: Of<"regex">, output: string): ScoreResult {
  // Strip stateful flags: `g`/`y` would make .test() depend on lastIndex.
  const re = new RegExp(e.pattern, e.flags.replace(/[gy]/g, ""));
  const pass = re.test(output);
  return result(e, `regex /${e.pattern}/${e.flags}`, pass, pass ? "matched" : `no match in "${excerpt(output)}"`);
}

function findNeedles(values: string[], output: string, ignoreCase: boolean): string[] {
  const hay = ignoreCase ? output.toLowerCase() : output;
  return values.filter((v) => hay.includes(ignoreCase ? v.toLowerCase() : v));
}

export function scoreContains(e: Of<"contains">, output: string): ScoreResult {
  const found = findNeedles(e.values, output, e.ignoreCase);
  const missing = e.values.filter((v) => !found.includes(v));
  const pass = missing.length === 0;
  return result(
    e,
    `contains ${JSON.stringify(e.values)}`,
    pass,
    pass ? "all present" : `missing ${JSON.stringify(missing)}`,
  );
}

export function scoreNotContains(e: Of<"not_contains">, output: string): ScoreResult {
  const found = findNeedles(e.values, output, e.ignoreCase);
  const pass = found.length === 0;
  return result(
    e,
    `not_contains ${JSON.stringify(e.values)}`,
    pass,
    pass ? "none present" : `found forbidden ${JSON.stringify(found)}`,
  );
}

export function scoreJsonSchema(e: Of<"json_schema">, output: string): ScoreResult {
  const labelText = "json_schema";
  const parsed = parseJsonOutput(output);
  if (!parsed.ok) return result(e, labelText, false, parsed.error);
  const violations = schemaViolations(compileJsonSchema(e.schema, labelText), parsed.value);
  const pass = violations.length === 0;
  return result(e, labelText, pass, pass ? "valid" : violations.join("; "));
}

export function scoreJsonField(e: Of<"json_field">, output: string): ScoreResult {
  const labelText = `json_field ${e.path} == ${JSON.stringify(e.equals)}`;
  const parsed = parseJsonOutput(output);
  if (!parsed.ok) return result(e, labelText, false, parsed.error);
  const field = getJsonPath(parsed.value, e.path);
  if (!field.found) return result(e, labelText, false, `path "${e.path}" not found`);
  const pass = jsonEquals(field.value, e.equals);
  return result(e, labelText, pass, pass ? "equal" : `got ${JSON.stringify(field.value)}`);
}
