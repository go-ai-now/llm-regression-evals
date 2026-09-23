import Anthropic from "@anthropic-ai/sdk";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.js";
import { AnthropicProvider, toProviderError, type MessagesClient } from "../src/providers/anthropic.js";
import { hashRequest, readFixtureFile } from "../src/providers/fixtures.js";
import { RecordingProvider, ReplayProvider } from "../src/providers/replay.js";
import type { ProviderRequest } from "../src/types.js";
import { FakeProvider, response, tempDir } from "./helpers.js";

const request: ProviderRequest = {
  model: "claude-haiku-4-5",
  system: "sys",
  messages: [{ role: "user", content: "hello" }],
  maxTokens: 100,
};

describe("hashRequest", () => {
  it("is stable and sensitive to every input that changes the answer", () => {
    const h = hashRequest(request);
    expect(hashRequest({ ...request })).toBe(h);
    expect(hashRequest({ ...request, model: "other" })).not.toBe(h);
    expect(hashRequest({ ...request, system: "sys2" })).not.toBe(h);
    expect(hashRequest({ ...request, maxTokens: 101 })).not.toBe(h);
    expect(hashRequest({ ...request, messages: [{ role: "user", content: "hello!" }] })).not.toBe(h);
  });
});

describe("ReplayProvider", () => {
  const fixtures = {
    version: 1 as const,
    entries: { c1: { requestHash: hashRequest(request), response: response("recorded") } },
  };

  it("returns the recorded response for a matching request", async () => {
    const replay = new ReplayProvider(fixtures);
    expect((await replay.complete(request, { fixtureKey: "c1" })).text).toBe("recorded");
  });

  it("fails with a non-retryable error on a missing fixture", async () => {
    const replay = new ReplayProvider(fixtures);
    await expect(replay.complete(request, { fixtureKey: "nope" })).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("no fixture"),
    });
  });

  it("detects a stale fixture when the prompt changed", async () => {
    const replay = new ReplayProvider(fixtures);
    const changed = { ...request, messages: [{ role: "user" as const, content: "hello v2" }] };
    await expect(replay.complete(changed, { fixtureKey: "c1" })).rejects.toThrow(/stale/);
  });
});

describe("RecordingProvider", () => {
  it("records successful calls into a replayable fixtures file", async () => {
    const recorder = new RecordingProvider(new FakeProvider(async () => response("live answer")));
    await recorder.complete(request, { fixtureKey: "c1" });
    const path = join(await tempDir(), "f.json");
    await recorder.save(path, new Date("2026-01-01T00:00:00Z"));

    const file = await readFixtureFile(path);
    expect(file.note).toContain("2026-01-01");
    const replay = new ReplayProvider(file);
    expect((await replay.complete(request, { fixtureKey: "c1" })).text).toBe("live answer");
  });
});

describe("AnthropicProvider", () => {
  function fakeClient(impl: MessagesClient["messages"]["create"]): MessagesClient {
    return { messages: { create: impl } };
  }

  it("maps the request and normalises text and usage", async () => {
    let sent: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const provider = new AnthropicProvider({
      apiKey: "unused",
      client: fakeClient(async (params) => {
        sent = params;
        return {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: [
            { type: "text", text: "part1 ", citations: null },
            { type: "text", text: "part2", citations: null },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 7, cache_creation_input_tokens: null, cache_read_input_tokens: 3 },
        } as unknown as Anthropic.Message;
      }),
    });
    const res = await provider.complete(request, { fixtureKey: "c1" });
    expect(sent).toMatchObject({ model: "claude-haiku-4-5", max_tokens: 100, system: "sys" });
    expect(sent).not.toHaveProperty("temperature");
    expect(res).toEqual({
      text: "part1 part2",
      model: "claude-haiku-4-5-20251001",
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 7, cacheCreationInputTokens: 0, cacheReadInputTokens: 3 },
    });
  });

  it("classifies SDK errors as retryable or not", () => {
    const rateLimited = toProviderError(
      new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers({ "retry-after": "2" })),
    );
    expect(rateLimited).toMatchObject({ retryable: true, status: 429, retryAfterMs: 2000 });

    const overloaded = toProviderError(Anthropic.APIError.generate(529, undefined, "overloaded", new Headers()));
    expect(overloaded).toMatchObject({ retryable: true, status: 529 });

    const badRequest = toProviderError(Anthropic.APIError.generate(400, undefined, "bad", new Headers()));
    expect(badRequest).toMatchObject({ retryable: false, status: 400 });

    const network = toProviderError(new Anthropic.APIConnectionError({ message: "socket hang up" }));
    expect(network.retryable).toBe(true);

    expect(toProviderError(new Error("boom"))).toBeInstanceOf(ProviderError);
  });

  it("throws ProviderError from complete() when the client fails", async () => {
    const provider = new AnthropicProvider({
      apiKey: "unused",
      client: fakeClient(async () => {
        throw new Anthropic.APIConnectionError({ message: "offline" });
      }),
    });
    await expect(provider.complete(request, { fixtureKey: "c1" })).rejects.toMatchObject({ retryable: true });
  });
});
