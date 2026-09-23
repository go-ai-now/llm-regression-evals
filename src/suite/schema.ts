import { z } from "zod";
import { DEFAULTS, JUDGE_SCALE } from "../config.js";
import type { Expectation } from "../types.js";

/** Case ids are used in fixture keys and report files, so keep them simple. */
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const label = z.string().min(1).optional();

/** Accepts `value: "x"` or `values: ["x", "y"]` and normalises to `values`. */
const needles = z
  .object({ value: z.string().min(1).optional(), values: z.array(z.string().min(1)).min(1).optional() })
  .refine((v) => (v.value === undefined) !== (v.values === undefined), {
    message: "provide exactly one of `value` or `values`",
  });

const containsLike = <T extends "contains" | "not_contains">(type: T) =>
  z
    .object({ type: z.literal(type), ignoreCase: z.boolean().default(false), label })
    .and(needles)
    .transform((v) => ({
      type,
      values: v.values ?? (v.value === undefined ? [] : [v.value]),
      ignoreCase: v.ignoreCase,
      ...(v.label === undefined ? {} : { label: v.label }),
    }));

const exact = z.object({
  type: z.literal("exact"),
  value: z.string(),
  trim: z.boolean().default(true),
  ignoreCase: z.boolean().default(false),
  label,
});

const regex = z.object({
  type: z.literal("regex"),
  pattern: z.string().min(1),
  flags: z.string().regex(/^[dgimsuvy]*$/, "invalid regex flags").default(""),
  label,
});

const jsonSchema = z.object({
  type: z.literal("json_schema"),
  schema: z.record(z.string(), z.unknown()),
  label,
});

const jsonField = z.object({
  type: z.literal("json_field"),
  path: z.string().min(1),
  equals: z.unknown().refine((v) => v !== undefined, { message: "`equals` is required" }),
  label,
});

const llmJudge = z.object({
  type: z.literal("llm_judge"),
  rubric: z.string().min(1),
  passThreshold: z.number().int().min(JUDGE_SCALE.min).max(JUDGE_SCALE.max).default(DEFAULTS.judgePassThreshold),
  label,
});

export const ExpectationSchema: z.ZodType<Expectation, unknown> = z.union([
  exact,
  regex,
  containsLike("contains"),
  containsLike("not_contains"),
  jsonSchema,
  jsonField,
  llmJudge,
]) as z.ZodType<Expectation, unknown>;

const vars = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

const pricing = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
  cacheReadPerMTok: z.number().nonnegative().optional(),
});

export const CaseFileSchema = z.object({
  id: z.string().regex(CASE_ID, "case id may only contain letters, digits, '.', '_' and '-'"),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  vars: vars.default({}),
  prompt: z.string().min(1).optional(),
  system: z.string().optional(),
  expect: z.array(ExpectationSchema).default([]),
});

export const SuiteFileSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  maxTokens: z.number().int().positive().default(DEFAULTS.maxTokens),
  system: z.string().optional(),
  prompt: z.string().min(1).optional(),
  judge: z.object({ model: z.string().min(1).optional() }).default({}),
  pricing: z.record(z.string(), pricing).default({}),
  defaults: z
    .object({ vars: vars.default({}), expect: z.array(ExpectationSchema).default([]) })
    .default({ vars: {}, expect: [] }),
  cases: z.array(CaseFileSchema).min(1, "a suite needs at least one case"),
});

export type SuiteFile = z.infer<typeof SuiteFileSchema>;
export type CaseFile = z.infer<typeof CaseFileSchema>;
