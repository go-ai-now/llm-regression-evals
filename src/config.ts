/**
 * Central defaults. Anything tunable at runtime lives here instead of being
 * scattered as magic numbers.
 */
export const DEFAULTS = {
  maxTokens: 1024,
  concurrency: 4,
  retries: 3,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 20_000,
  requestTimeoutMs: 60_000,
  judgePassThreshold: 4,
  judgeMaxTokens: 512,
} as const;

/** Judge grades are integers on this inclusive scale. */
export const JUDGE_SCALE = { min: 1, max: 5 } as const;

/** Tokens per pricing unit ("per million tokens"). */
export const TOKENS_PER_PRICING_UNIT = 1_000_000;

/** Current on-disk fixture format version. */
export const FIXTURE_FILE_VERSION = 1;

/** Process exit codes used by the CLI. */
export const EXIT_CODES = {
  ok: 0,
  failed: 1,
  configError: 2,
} as const;

/** Environment variable holding the Anthropic API key. */
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
