import { ProviderError } from "../errors.js";

export interface RetryOptions {
  /** Extra attempts after the first one. 0 disables retries. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; must return a value in [0, 1). */
  random?: () => number;
}

/** Lower bound of the jitter factor: delays land in [50%, 100%] of the backoff. */
const JITTER_FLOOR = 0.5;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Only ProviderErrors flagged retryable are retried; anything else is a bug or a 4xx. */
export function isRetryable(error: unknown): boolean {
  return error instanceof ProviderError && error.retryable;
}

/** Exponential backoff with jitter, honouring a server `retry-after` when larger. */
export function backoffDelayMs(attempt: number, options: RetryOptions, error: unknown): number {
  const random = options.random ?? Math.random;
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  const jittered = exponential * (JITTER_FLOOR + (1 - JITTER_FLOOR) * random());
  const serverHint = error instanceof ProviderError ? (error.retryAfterMs ?? 0) : 0;
  return Math.round(Math.min(options.maxDelayMs, Math.max(jittered, serverHint)));
}

export class RetryExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(lastError instanceof Error ? lastError.message : String(lastError), { cause: lastError });
    this.name = "RetryExhaustedError";
  }
}

/**
 * Runs `fn`, retrying retryable failures with backoff. Resolves with the value
 * and the number of attempts; rejects with RetryExhaustedError (which carries
 * the attempt count) once retries are exhausted or the error is not retryable.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<{ value: T; attempts: number }> {
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.retries + 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error)) throw new RetryExhaustedError(attempt, error);
      await sleep(backoffDelayMs(attempt, options, error));
    }
  }
}
