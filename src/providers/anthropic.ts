import Anthropic from "@anthropic-ai/sdk";
import { DEFAULTS } from "../config.js";
import { ProviderError, errorMessage } from "../errors.js";
import type { CallContext, Provider, ProviderRequest, ProviderResponse, TokenUsage } from "../types.js";

/** HTTP statuses worth retrying: timeout, conflict, rate limit (5xx handled separately). */
const RETRYABLE_STATUSES = new Set([408, 409, 429]);
const SERVER_ERROR_MIN = 500;
const MS_PER_SECOND = 1000;

/** The slice of the SDK client this provider uses; lets tests inject a fake. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface AnthropicProviderOptions {
  apiKey: string;
  timeoutMs?: number;
  /** Inject a client (tests); defaults to a real SDK client. */
  client?: MessagesClient;
}

function parseRetryAfter(headers: Headers | undefined): number | undefined {
  const value = headers?.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * MS_PER_SECOND : undefined;
}

/** Maps SDK errors onto ProviderError so the runner stays SDK-agnostic. */
export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`connection error: ${error.message}`, { retryable: true, cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    const retryable = status !== undefined && (RETRYABLE_STATUSES.has(status) || status >= SERVER_ERROR_MIN);
    const retryAfterMs = parseRetryAfter(error.headers);
    return new ProviderError(`Anthropic API error ${status ?? "?"}: ${error.message}`, {
      retryable,
      ...(status === undefined ? {} : { status }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      cause: error,
    });
  }
  return new ProviderError(errorMessage(error), { retryable: false, cause: error });
}

export function normaliseUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Anthropic Messages API provider.
 *
 * SDK-level retries are disabled (`maxRetries: 0`): the runner owns retries so
 * attempts and backoff are counted in one place. Sampling parameters
 * (temperature/top_p/top_k) are deliberately not sent - newer models reject
 * non-default values; reproducibility comes from the replay provider instead.
 */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly client: MessagesClient;

  constructor(options: AnthropicProviderOptions) {
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        maxRetries: 0,
        timeout: options.timeoutMs ?? DEFAULTS.requestTimeoutMs,
      });
  }

  async complete(request: ProviderRequest, _context: CallContext): Promise<ProviderResponse> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        ...(request.system === undefined ? {} : { system: request.system }),
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      });
    } catch (error) {
      throw toProviderError(error);
    }
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return { text, model: message.model, usage: normaliseUsage(message.usage), stopReason: message.stop_reason };
  }
}
