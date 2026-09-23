import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ConfigError, errorMessage } from "../errors.js";
import type { CaseStatus, RunReport } from "../types.js";

/** Only the fields needed for diffing are validated, so older reports stay usable. */
const BaselineSchema = z.object({
  schemaVersion: z.literal(1),
  suite: z.string(),
  summary: z.object({ passRate: z.number() }),
  cases: z.array(z.object({ id: z.string(), status: z.enum(["pass", "fail", "error"]) })),
});

export type Baseline = z.infer<typeof BaselineSchema>;

export interface StatusChange {
  id: string;
  baseline: CaseStatus;
  current: CaseStatus;
}

export interface BaselineDiff {
  /** Passed in the baseline, does not pass now. These fail the build. */
  regressions: StatusChange[];
  /** Did not pass in the baseline, passes now. */
  fixed: StatusChange[];
  /** Failing both times - known issues, reported but not blocking. */
  stillFailing: StatusChange[];
  /** In the current run but not the baseline. */
  newCases: string[];
  /** New cases that do not pass. Unproven behaviour, so these fail the build too. */
  newFailures: string[];
  /** In the baseline but no longer in the suite. */
  removedCases: string[];
  passRateDelta: number;
  suiteMismatch: boolean;
}

export async function readBaseline(path: string): Promise<Baseline> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`cannot read baseline ${path}: ${errorMessage(error)}`, { cause: error });
  }
  const parsed = BaselineSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`invalid baseline ${path}: expected a JSON report written by --json/--save-baseline`);
  }
  return parsed.data;
}

export function compareToBaseline(current: RunReport, baseline: Baseline): BaselineDiff {
  const before = new Map(baseline.cases.map((c) => [c.id, c.status]));
  const currentIds = new Set(current.cases.map((c) => c.id));
  const diff: BaselineDiff = {
    regressions: [],
    fixed: [],
    stillFailing: [],
    newCases: [],
    newFailures: [],
    removedCases: baseline.cases.filter((c) => !currentIds.has(c.id)).map((c) => c.id),
    passRateDelta: current.summary.passRate - baseline.summary.passRate,
    suiteMismatch: current.suite !== baseline.suite,
  };
  for (const c of current.cases) {
    const was = before.get(c.id);
    if (was === undefined) {
      diff.newCases.push(c.id);
      if (c.status !== "pass") diff.newFailures.push(c.id);
      continue;
    }
    const change = { id: c.id, baseline: was, current: c.status };
    if (was === "pass" && c.status !== "pass") diff.regressions.push(change);
    else if (was !== "pass" && c.status === "pass") diff.fixed.push(change);
    else if (was !== "pass" && c.status !== "pass") diff.stillFailing.push(change);
  }
  return diff;
}
