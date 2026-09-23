import { summariseCost } from "../cost.js";
import { errorMessage } from "../errors.js";
import { score, type JudgeCall } from "../scorers/index.js";
import type {
  CallRecord,
  CaseResult,
  EvalCase,
  EvalSuite,
  Provider,
  ProviderRequest,
  RunReport,
  RunSummary,
  ScoreResult,
} from "../types.js";
import { mapWithConcurrency } from "./concurrency.js";
import { RetryExhaustedError, withRetry, type RetryOptions } from "./retry.js";

export interface RunOptions {
  provider: Provider;
  /** Provider for llm_judge calls; defaults to `provider`. */
  judgeProvider?: Provider;
  concurrency: number;
  retry: RetryOptions;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Called as each case finishes (in completion order), e.g. for progress output. */
  onCaseComplete?: (result: CaseResult) => void;
}

/** Wraps a provider call with retry and records usage for cost accounting. */
async function meteredCall(
  provider: Provider,
  request: ProviderRequest,
  fixtureKey: string,
  purpose: CallRecord["purpose"],
  retry: RetryOptions,
  calls: CallRecord[],
) {
  const { value, attempts } = await withRetry(() => provider.complete(request, { fixtureKey }), retry);
  calls.push({ purpose, model: value.model, usage: value.usage, attempts });
  return value;
}

function describeFailure(error: unknown, what: string): string {
  if (error instanceof RetryExhaustedError) {
    const suffix = error.attempts > 1 ? ` after ${error.attempts} attempts` : "";
    return `${what} failed${suffix}: ${errorMessage(error.lastError)}`;
  }
  return `${what} failed: ${errorMessage(error)}`;
}

async function evaluateCase(evalCase: EvalCase, suite: EvalSuite, options: RunOptions): Promise<CaseResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const calls: CallRecord[] = [];
  const base = {
    id: evalCase.id,
    ...(evalCase.description === undefined ? {} : { description: evalCase.description }),
    tags: evalCase.tags,
  };
  const finish = (partial: Pick<CaseResult, "status" | "output" | "scores"> & { error?: string }): CaseResult => ({
    ...base,
    ...partial,
    calls,
    durationMs: now() - startedAt,
  });

  let output: string;
  try {
    output = (await meteredCall(options.provider, evalCase.request, evalCase.id, "case", options.retry, calls)).text;
  } catch (error) {
    return finish({ status: "error", output: null, scores: [], error: describeFailure(error, "model call") });
  }

  const judgeProvider = options.judgeProvider ?? options.provider;
  const judge: JudgeCall = (request, fixtureKey) =>
    meteredCall(judgeProvider, request, fixtureKey, "judge", options.retry, calls);

  const scores: ScoreResult[] = [];
  try {
    for (const [index, expectation] of evalCase.expectations.entries()) {
      scores.push(await score(expectation, index, output, { evalCase, judgeModel: suite.judgeModel, judge }));
    }
  } catch (error) {
    return finish({ status: "error", output, scores, error: describeFailure(error, "scoring") });
  }
  return finish({ status: scores.every((s) => s.pass) ? "pass" : "fail", output, scores });
}

export function summarise(cases: CaseResult[]): RunSummary {
  const count = (status: CaseResult["status"]): number => cases.filter((c) => c.status === status).length;
  const passed = count("pass");
  return {
    total: cases.length,
    passed,
    failed: count("fail"),
    errored: count("error"),
    passRate: cases.length === 0 ? 0 : passed / cases.length,
  };
}

/** Runs every case of a suite with bounded concurrency and builds the report. */
export async function runSuite(suite: EvalSuite, options: RunOptions): Promise<RunReport> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const cases = await mapWithConcurrency(suite.cases, options.concurrency, async (evalCase) => {
    const result = await evaluateCase(evalCase, suite, options);
    options.onCaseComplete?.(result);
    return result;
  });
  return {
    schemaVersion: 1,
    suite: suite.name,
    provider: options.provider.name,
    model: suite.model,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: now() - startedAt,
    summary: summarise(cases),
    cost: summariseCost(
      cases.flatMap((c) => c.calls),
      suite.pricing,
    ),
    cases,
  };
}
