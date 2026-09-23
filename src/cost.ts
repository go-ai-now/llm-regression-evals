import { TOKENS_PER_PRICING_UNIT } from "./config.js";
import type { CallRecord, CostSummary, ModelPricing, TokenUsage } from "./types.js";

const HAIKU_4_5: ModelPricing = { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 };
const SONNET_4_5: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 };
const OPUS_4_5: ModelPricing = { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 };

/**
 * Built-in USD prices per million tokens (standard tier, 5-minute cache writes).
 * Prices change: treat this as a convenience, verify against Anthropic's
 * pricing page, and override per suite with the `pricing:` block. Models not
 * listed here get token counts but a `null` cost rather than a wrong number.
 */
export const BUILTIN_PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-haiku-4-5": HAIKU_4_5,
  "claude-haiku-4-5-20251001": HAIKU_4_5,
  "claude-sonnet-4-5": SONNET_4_5,
  "claude-sonnet-4-5-20250929": SONNET_4_5,
  "claude-opus-4-5": OPUS_4_5,
  "claude-opus-4-5-20251101": OPUS_4_5,
};

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

/** Cost in USD of one usage record; cache prices fall back to the input price. */
export function usageCostUsd(usage: TokenUsage, price: ModelPricing): number {
  const perToken = (perMTok: number): number => perMTok / TOKENS_PER_PRICING_UNIT;
  return (
    usage.inputTokens * perToken(price.inputPerMTok) +
    usage.outputTokens * perToken(price.outputPerMTok) +
    usage.cacheCreationInputTokens * perToken(price.cacheWritePerMTok ?? price.inputPerMTok) +
    usage.cacheReadInputTokens * perToken(price.cacheReadPerMTok ?? price.inputPerMTok)
  );
}

/** Aggregates every call of a run into token totals and (when priced) USD. */
export function summariseCost(calls: CallRecord[], overrides: Record<string, ModelPricing>): CostSummary {
  let usage = emptyUsage();
  let totalUsd = 0;
  const unpriced = new Set<string>();
  for (const call of calls) {
    usage = addUsage(usage, call.usage);
    const price = overrides[call.model] ?? BUILTIN_PRICING[call.model];
    if (price) totalUsd += usageCostUsd(call.usage, price);
    else unpriced.add(call.model);
  }
  return { usage, totalUsd: unpriced.size > 0 ? null : totalUsd, unpricedModels: [...unpriced].sort() };
}
