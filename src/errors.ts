/**
 * Error raised by providers. `retryable` tells the runner whether a retry with
 * backoff could plausibly succeed (rate limits, overload, network, 5xx).
 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** Server-suggested wait before retrying, if the provider sent one. */
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: { retryable: boolean; status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Raised for invalid suite files, missing fixtures files, bad CLI flags, etc. */
export class ConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigError";
  }
}

/** Extracts a readable message from any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
