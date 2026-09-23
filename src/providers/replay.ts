import { FIXTURE_FILE_VERSION } from "../config.js";
import { ProviderError } from "../errors.js";
import type { CallContext, Provider, ProviderRequest, ProviderResponse } from "../types.js";
import { hashRequest, readFixtureFile, writeFixtureFile, type FixtureFile } from "./fixtures.js";

/**
 * Deterministic provider that answers from recorded fixtures. Used in CI so the
 * suite runs with no API key and no spend. A missing or stale fixture is a
 * hard, non-retryable error - replay never invents an answer.
 */
export class ReplayProvider implements Provider {
  readonly name = "replay";

  constructor(private readonly fixtures: FixtureFile) {}

  static async fromFile(path: string): Promise<ReplayProvider> {
    return new ReplayProvider(await readFixtureFile(path));
  }

  async complete(request: ProviderRequest, context: CallContext): Promise<ProviderResponse> {
    const entry = this.fixtures.entries[context.fixtureKey];
    if (!entry) {
      throw new ProviderError(`no fixture recorded for "${context.fixtureKey}" (re-record with --record)`, {
        retryable: false,
      });
    }
    const actual = hashRequest(request);
    if (entry.requestHash !== actual) {
      throw new ProviderError(
        `fixture for "${context.fixtureKey}" is stale: the request (model, system, prompt or maxTokens) ` +
          `changed since it was recorded (recorded ${entry.requestHash}, now ${actual}); re-record with --record`,
        { retryable: false },
      );
    }
    return { ...entry.response, usage: { ...entry.response.usage } };
  }
}

/**
 * Wraps a live provider and captures every successful call so the run can be
 * saved as a fixtures file for later replay. When seeded with an existing
 * fixtures file, entries not re-recorded in this run (e.g. a case whose live
 * call errored) are kept rather than silently dropped.
 */
export class RecordingProvider implements Provider {
  readonly name: string;
  private readonly recorded: FixtureFile;
  private readonly freshKeys = new Set<string>();

  constructor(
    private readonly inner: Provider,
    seed?: FixtureFile,
  ) {
    this.name = `record(${inner.name})`;
    this.recorded = { version: FIXTURE_FILE_VERSION, entries: { ...(seed?.entries ?? {}) } };
  }

  async complete(request: ProviderRequest, context: CallContext): Promise<ProviderResponse> {
    const response = await this.inner.complete(request, context);
    this.recorded.entries[context.fixtureKey] = { requestHash: hashRequest(request), request, response };
    this.freshKeys.add(context.fixtureKey);
    return response;
  }

  /** Entries recorded from live calls during this run. */
  get recordedCount(): number {
    return this.freshKeys.size;
  }

  /** Entries carried over from the seed file without being re-recorded. */
  get preservedCount(): number {
    return Object.keys(this.recorded.entries).length - this.freshKeys.size;
  }

  async save(path: string, recordedAt: Date = new Date()): Promise<void> {
    const note = `Recorded via ${this.inner.name} on ${recordedAt.toISOString()}`;
    await writeFixtureFile(path, { ...this.recorded, note });
  }
}
