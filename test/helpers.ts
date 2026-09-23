import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSuite } from "../src/suite/loadSuite.js";
import type { CallContext, EvalSuite, Provider, ProviderRequest, ProviderResponse, TokenUsage } from "../src/types.js";

export function usage(inputTokens = 10, outputTokens = 5): TokenUsage {
  return { inputTokens, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

export function response(text: string, model = "test-model"): ProviderResponse {
  return { text, model, usage: usage(), stopReason: "end_turn" };
}

/** Provider driven by a function, recording every call it receives. */
export class FakeProvider implements Provider {
  readonly name = "fake";
  readonly calls: Array<{ request: ProviderRequest; context: CallContext }> = [];

  constructor(private readonly handler: (request: ProviderRequest, context: CallContext) => Promise<ProviderResponse>) {}

  complete(request: ProviderRequest, context: CallContext): Promise<ProviderResponse> {
    this.calls.push({ request, context });
    return this.handler(request, context);
  }
}

/** Builds a suite in memory from a plain object, as if loaded from YAML. */
export function makeSuite(raw: Record<string, unknown>): EvalSuite {
  return resolveSuite({ name: "t", model: "test-model", prompt: "{{q}}", ...raw }, "/virtual/suite.yaml");
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "llm-regression-evals-test-"));
}

/** A retry config that never really sleeps. */
export const NO_WAIT_RETRY = { retries: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined };
