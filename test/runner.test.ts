import { describe, expect, it } from "vitest";
import { summariseCost } from "../src/cost.js";
import { ProviderError } from "../src/errors.js";
import { mapWithConcurrency } from "../src/runner/concurrency.js";
import { backoffDelayMs, withRetry, RetryExhaustedError } from "../src/runner/retry.js";
import { runSuite } from "../src/runner/runSuite.js";
import { FakeProvider, NO_WAIT_RETRY, makeSuite, response, usage } from "./helpers.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

describe("mapWithConcurrency", () => {
  it("never exceeds the limit and preserves input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight -= 1;
      return n * 10;
    });
    expect(peak).toBe(3);
    expect(out).toEqual([50, 10, 40, 20, 30, 0, 60]);
  });

  it("handles empty input and rejects an invalid limit", async () => {
    expect(await mapWithConcurrency([], 2, async () => 1)).toEqual([]);
    await expect(mapWithConcurrency([1], 0, async () => 1)).rejects.toThrow(RangeError);
  });
});

describe("withRetry", () => {
  const retryable = (): ProviderError => new ProviderError("429", { retryable: true, status: 429 });

  it("retries retryable errors with growing backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const result = await withRetry(
      async () => {
        n += 1;
        if (n < 3) throw retryable();
        return "ok";
      },
      { retries: 3, baseDelayMs: 100, maxDelayMs: 10_000, sleep: async (ms) => void sleeps.push(ms), random: () => 1 },
    );
    expect(result).toEqual({ value: "ok", attempts: 3 });
    expect(sleeps).toEqual([100, 200]);
  });

  it("gives up after the configured retries", async () => {
    let n = 0;
    const run = withRetry(
      async () => {
        n += 1;
        throw retryable();
      },
      { ...NO_WAIT_RETRY, retries: 2 },
    );
    await expect(run).rejects.toBeInstanceOf(RetryExhaustedError);
    await expect(run).rejects.toMatchObject({ attempts: 3 });
    expect(n).toBe(3);
  });

  it("does not retry non-retryable or unknown errors", async () => {
    for (const error of [new ProviderError("400", { retryable: false, status: 400 }), new TypeError("bug")]) {
      let n = 0;
      await expect(
        withRetry(async () => {
          n += 1;
          throw error;
        }, NO_WAIT_RETRY),
      ).rejects.toMatchObject({ attempts: 1 });
      expect(n).toBe(1);
    }
  });

  it("applies jitter, caps at maxDelayMs, and honours a larger retry-after", () => {
    const opts = { retries: 5, baseDelayMs: 1000, maxDelayMs: 5000 };
    expect(backoffDelayMs(1, { ...opts, random: () => 0 }, null)).toBe(500);
    expect(backoffDelayMs(10, { ...opts, random: () => 1 }, null)).toBe(5000);
    const hinted = new ProviderError("slow down", { retryable: true, retryAfterMs: 3000 });
    expect(backoffDelayMs(1, { ...opts, random: () => 0 }, hinted)).toBe(3000);
  });
});

describe("runSuite", () => {
  const suite = makeSuite({
    cases: ["a", "b", "c", "d", "e"].map((id) => ({ id, vars: { q: id }, expect: [{ type: "exact", value: id.toUpperCase() }] })),
  });

  it("scores every case, respecting the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const provider = new FakeProvider(async (req) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      const q = req.messages[0]?.content ?? "";
      return response(q === "c" ? "wrong" : q.toUpperCase());
    });
    const report = await runSuite(suite, { provider, concurrency: 2, retry: NO_WAIT_RETRY });
    expect(peak).toBeLessThanOrEqual(2);
    expect(report.summary).toEqual({ total: 5, passed: 4, failed: 1, errored: 0, passRate: 0.8 });
    expect(report.cases.map((c) => c.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(provider.calls.map((c) => c.context.fixtureKey).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("retries transient failures and records the attempt count", async () => {
    const failures = new Map([["a", 2]]);
    const provider = new FakeProvider(async (req) => {
      const q = req.messages[0]?.content ?? "";
      const left = failures.get(q) ?? 0;
      if (left > 0) {
        failures.set(q, left - 1);
        throw new ProviderError("overloaded", { retryable: true, status: 529 });
      }
      return response(q.toUpperCase());
    });
    const report = await runSuite(suite, { provider, concurrency: 5, retry: NO_WAIT_RETRY });
    expect(report.summary.passed).toBe(5);
    expect(report.cases[0]?.calls[0]?.attempts).toBe(3);
  });

  it("marks a case as error (not a crash) when the provider keeps failing", async () => {
    const provider = new FakeProvider(async (req) => {
      if (req.messages[0]?.content === "b") throw new ProviderError("bad request", { retryable: false, status: 400 });
      return response((req.messages[0]?.content ?? "").toUpperCase());
    });
    const report = await runSuite(suite, { provider, concurrency: 2, retry: NO_WAIT_RETRY });
    const b = report.cases.find((c) => c.id === "b");
    expect(b?.status).toBe("error");
    expect(b?.error).toContain("bad request");
    expect(report.summary.errored).toBe(1);
  });

  it("routes judge calls through the judge provider with a distinct fixture key", async () => {
    const judgeSuite = makeSuite({
      judge: { model: "judge-model" },
      cases: [{ id: "j", vars: { q: "x" }, expect: [{ type: "contains", value: "x" }, { type: "llm_judge", rubric: "r" }] }],
    });
    const provider = new FakeProvider(async () => response("x"));
    const judgeProvider = new FakeProvider(async () => response('{"score":5,"reason":"fine"}', "judge-model"));
    const report = await runSuite(judgeSuite, { provider, judgeProvider, concurrency: 1, retry: NO_WAIT_RETRY });
    expect(report.cases[0]?.status).toBe("pass");
    expect(judgeProvider.calls[0]?.context.fixtureKey).toBe("j#judge1");
    expect(judgeProvider.calls[0]?.request.model).toBe("judge-model");
    expect(report.cases[0]?.calls.map((c) => c.purpose)).toEqual(["case", "judge"]);
  });
});

describe("cost accounting", () => {
  it("sums usage across calls and prices known models", () => {
    const cost = summariseCost(
      [
        { purpose: "case", model: "claude-haiku-4-5", usage: usage(1_000_000, 0), attempts: 1 },
        { purpose: "judge", model: "claude-haiku-4-5", usage: usage(0, 1_000_000), attempts: 1 },
      ],
      {},
    );
    expect(cost.usage).toMatchObject({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost.totalUsd).toBeCloseTo(6);
  });

  it("returns null cost (not zero) for unpriced models, and accepts overrides", () => {
    const calls = [{ purpose: "case" as const, model: "mystery", usage: usage(1_000_000, 0), attempts: 1 }];
    expect(summariseCost(calls, {})).toMatchObject({ totalUsd: null, unpricedModels: ["mystery"] });
    expect(summariseCost(calls, { mystery: { inputPerMTok: 2, outputPerMTok: 4 } }).totalUsd).toBeCloseTo(2);
  });

  it("prices cache reads and writes, falling back to the input price", () => {
    const calls = [
      {
        purpose: "case" as const,
        model: "m",
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 },
        attempts: 1,
      },
    ];
    expect(summariseCost(calls, { m: { inputPerMTok: 1, outputPerMTok: 1 } }).totalUsd).toBeCloseTo(2);
    expect(
      summariseCost(calls, { m: { inputPerMTok: 1, outputPerMTok: 1, cacheWritePerMTok: 3, cacheReadPerMTok: 0.5 } }).totalUsd,
    ).toBeCloseTo(3.5);
  });
});
