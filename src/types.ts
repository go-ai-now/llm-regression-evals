/**
 * Core domain types shared by the loader, providers, scorers, runner and reporters.
 */

/** A single chat turn sent to a provider. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Provider-agnostic completion request. */
export interface ProviderRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
}

/** Token counts normalised from provider usage fields. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Provider-agnostic completion response. */
export interface ProviderResponse {
  text: string;
  /** The model that actually served the request, as reported by the provider. */
  model: string;
  usage: TokenUsage;
  stopReason: string | null;
}

/** Per-call context. `fixtureKey` identifies the call for record/replay providers. */
export interface CallContext {
  fixtureKey: string;
}

/**
 * A pluggable LLM backend. Implementations must throw `ProviderError` for
 * failures the runner should know how to classify (retryable or not).
 */
export interface Provider {
  readonly name: string;
  complete(request: ProviderRequest, context: CallContext): Promise<ProviderResponse>;
}

/** A single declarative expectation attached to a case. */
export type Expectation =
  | { type: "exact"; value: string; trim: boolean; ignoreCase: boolean; label?: string }
  | { type: "regex"; pattern: string; flags: string; label?: string }
  | { type: "contains"; values: string[]; ignoreCase: boolean; label?: string }
  | { type: "not_contains"; values: string[]; ignoreCase: boolean; label?: string }
  | { type: "json_schema"; schema: Record<string, unknown>; label?: string }
  | { type: "json_field"; path: string; equals: unknown; label?: string }
  | { type: "llm_judge"; rubric: string; passThreshold: number; label?: string };

export type ExpectationType = Expectation["type"];

/** A fully resolved test case (template rendered, defaults merged). */
export interface EvalCase {
  id: string;
  description?: string;
  tags: string[];
  request: ProviderRequest;
  expectations: Expectation[];
}

/** Optional per-million-token prices used for cost accounting. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok?: number;
  cacheReadPerMTok?: number;
}

/** A fully resolved suite ready to run. */
export interface EvalSuite {
  name: string;
  /** Absolute path of the file the suite was loaded from. */
  sourcePath: string;
  model: string;
  judgeModel: string;
  cases: EvalCase[];
  pricing: Record<string, ModelPricing>;
}

/** Outcome of one expectation against one output. */
export interface ScoreResult {
  type: ExpectationType;
  label: string;
  pass: boolean;
  reason: string;
  /** Optional numeric score (e.g. the judge's 1-5 grade). */
  score?: number;
}

/** One provider call made while evaluating a case, kept for cost accounting. */
export interface CallRecord {
  purpose: "case" | "judge";
  model: string;
  usage: TokenUsage;
  attempts: number;
}

export type CaseStatus = "pass" | "fail" | "error";

export interface CaseResult {
  id: string;
  description?: string;
  tags: string[];
  status: CaseStatus;
  output: string | null;
  scores: ScoreResult[];
  calls: CallRecord[];
  durationMs: number;
  error?: string;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
}

export interface CostSummary {
  usage: TokenUsage;
  /** Total USD cost, or null when at least one model has no known pricing. */
  totalUsd: number | null;
  unpricedModels: string[];
}

/** The machine-readable run report. Also the on-disk baseline format. */
export interface RunReport {
  schemaVersion: 1;
  suite: string;
  provider: string;
  model: string;
  startedAt: string;
  durationMs: number;
  summary: RunSummary;
  cost: CostSummary;
  cases: CaseResult[];
}
