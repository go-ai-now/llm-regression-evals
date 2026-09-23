import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { FIXTURE_FILE_VERSION } from "../config.js";
import { ConfigError, errorMessage } from "../errors.js";
import type { ProviderRequest } from "../types.js";

/** Hex chars of the SHA-256 digest kept; plenty to detect accidental drift. */
const HASH_LENGTH = 16;

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative().default(0),
  cacheReadInputTokens: z.number().int().nonnegative().default(0),
});

const FixtureEntrySchema = z.object({
  requestHash: z.string().min(1),
  request: z.unknown().optional(),
  response: z.object({
    text: z.string(),
    model: z.string(),
    usage: UsageSchema,
    stopReason: z.string().nullable().default(null),
  }),
});

const FixtureFileSchema = z.object({
  version: z.literal(FIXTURE_FILE_VERSION),
  /** Free-text provenance, e.g. when and against which provider the file was recorded. */
  note: z.string().optional(),
  entries: z.record(z.string(), FixtureEntrySchema),
});

export type FixtureEntry = z.infer<typeof FixtureEntrySchema>;
export type FixtureFile = z.infer<typeof FixtureFileSchema>;

/**
 * Stable hash of everything that influences the model's answer. If any of it
 * changes, replayed fixtures no longer represent the current prompt.
 */
export function hashRequest(request: ProviderRequest): string {
  const canonical = JSON.stringify({
    model: request.model,
    system: request.system ?? null,
    maxTokens: request.maxTokens,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, HASH_LENGTH);
}

export async function readFixtureFile(path: string): Promise<FixtureFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`cannot read fixtures file ${path}: ${errorMessage(error)}`, { cause: error });
  }
  const parsed = FixtureFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`invalid fixtures file ${path}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}

/** Writes fixtures with sorted keys so re-recording produces reviewable diffs. */
export async function writeFixtureFile(path: string, file: FixtureFile): Promise<void> {
  const entries = Object.fromEntries(Object.entries(file.entries).sort(([a], [b]) => a.localeCompare(b)));
  const body = { version: file.version, ...(file.note === undefined ? {} : { note: file.note }), entries };
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}
