import type { EvalCase, Expectation, ScoreResult } from "../types.js";
import {
  scoreContains,
  scoreExact,
  scoreJsonField,
  scoreJsonSchema,
  scoreNotContains,
  scoreRegex,
} from "./deterministic.js";
import { scoreLlmJudge, type JudgeCall } from "./llmJudge.js";

export interface ScoreContext {
  evalCase: EvalCase;
  judgeModel: string;
  judge: JudgeCall;
}

/** Fixture key for the n-th expectation's judge call within a case. */
export function judgeFixtureKey(caseId: string, expectationIndex: number): string {
  return `${caseId}#judge${expectationIndex}`;
}

/** Dispatches one expectation to its scorer. */
export async function score(
  e: Expectation,
  expectationIndex: number,
  output: string,
  ctx: ScoreContext,
): Promise<ScoreResult> {
  switch (e.type) {
    case "exact":
      return scoreExact(e, output);
    case "regex":
      return scoreRegex(e, output);
    case "contains":
      return scoreContains(e, output);
    case "not_contains":
      return scoreNotContains(e, output);
    case "json_schema":
      return scoreJsonSchema(e, output);
    case "json_field":
      return scoreJsonField(e, output);
    case "llm_judge":
      return scoreLlmJudge(e, output, ctx.evalCase, ctx.judgeModel, ctx.judge, judgeFixtureKey(ctx.evalCase.id, expectationIndex));
  }
}

export { parseJsonOutput, compileJsonSchema, getJsonPath } from "./json.js";
export { buildJudgeRequest, parseJudgeReply, JUDGE_SYSTEM_PROMPT } from "./llmJudge.js";
export type { JudgeCall } from "./llmJudge.js";
