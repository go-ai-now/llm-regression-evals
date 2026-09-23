/** Public library API. The CLI (`llm-regression-evals`) is built on exactly these pieces. */
export { main, parseCliArgs, USAGE } from "./cli.js";
export { loadSuite, resolveSuite } from "./suite/loadSuite.js";
export { runSuite, summarise } from "./runner/runSuite.js";
export { withRetry, backoffDelayMs, isRetryable, RetryExhaustedError } from "./runner/retry.js";
export { mapWithConcurrency } from "./runner/concurrency.js";
export { score, judgeFixtureKey } from "./scorers/index.js";
export { AnthropicProvider, toProviderError, normaliseUsage } from "./providers/anthropic.js";
export { ReplayProvider, RecordingProvider } from "./providers/replay.js";
export { hashRequest, readFixtureFile, writeFixtureFile } from "./providers/fixtures.js";
export { compareToBaseline, readBaseline } from "./report/baseline.js";
export { toJUnitXml } from "./report/junit.js";
export { summariseCost, BUILTIN_PRICING } from "./cost.js";
export { ProviderError, ConfigError } from "./errors.js";
export type * from "./types.js";
export type { BaselineDiff } from "./report/baseline.js";
export type { RunOptions } from "./runner/runSuite.js";
export type { RetryOptions } from "./runner/retry.js";
export type { CliDeps } from "./cli.js";
