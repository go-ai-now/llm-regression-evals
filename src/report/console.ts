import type { BaselineDiff } from "./baseline.js";
import type { CaseResult, RunReport } from "../types.js";

const PERCENT = 100;
const USD_DECIMALS = 6;

const STATUS_MARK: Record<CaseResult["status"], string> = { pass: "PASS ", fail: "FAIL ", error: "ERROR" };

function percent(ratio: number): string {
  return `${(ratio * PERCENT).toFixed(1)}%`;
}

/** One line per case plus indented reasons for failed expectations. */
export function formatCaseLine(c: CaseResult): string {
  const retries = c.calls.reduce((n, call) => n + call.attempts - 1, 0);
  const retryNote = retries > 0 ? `, ${retries} retr${retries === 1 ? "y" : "ies"}` : "";
  const lines = [`  ${STATUS_MARK[c.status]} ${c.id} (${c.durationMs}ms, ${c.calls.length} call(s)${retryNote})`];
  if (c.error) lines.push(`         ${c.error}`);
  for (const s of c.scores.filter((x) => !x.pass)) lines.push(`         - ${s.label}: ${s.reason}`);
  return lines.join("\n");
}

export function formatSummary(report: RunReport, diff?: BaselineDiff): string {
  const { summary, cost } = report;
  const out: string[] = [
    "",
    `Suite:    ${report.suite}  (provider: ${report.provider}, model: ${report.model})`,
    `Results:  ${summary.passed}/${summary.total} passed (${percent(summary.passRate)}), ${summary.failed} failed, ${summary.errored} errored`,
    `Tokens:   ${cost.usage.inputTokens} in / ${cost.usage.outputTokens} out` +
      ` (cache write ${cost.usage.cacheCreationInputTokens}, cache read ${cost.usage.cacheReadInputTokens})`,
    cost.totalUsd === null
      ? `Cost:     unknown (no pricing for: ${cost.unpricedModels.join(", ")}; add a pricing: block)`
      : `Cost:     $${cost.totalUsd.toFixed(USD_DECIMALS)}`,
  ];
  if (diff) {
    const sign = diff.passRateDelta >= 0 ? "+" : "";
    out.push(`Baseline: pass rate ${sign}${percent(diff.passRateDelta)}`);
    if (diff.suiteMismatch) out.push("  warning: baseline was recorded for a different suite name");
    for (const r of diff.regressions) out.push(`  REGRESSION ${r.id}: ${r.baseline} -> ${r.current}`);
    for (const r of diff.fixed) out.push(`  fixed      ${r.id}: ${r.baseline} -> ${r.current}`);
    for (const r of diff.stillFailing) out.push(`  known      ${r.id}: still ${r.current}`);
    const newFailures = new Set(diff.newFailures);
    for (const id of diff.newCases) out.push(newFailures.has(id) ? `  NEW FAIL   ${id}` : `  new        ${id}`);
    for (const id of diff.removedCases) out.push(`  removed    ${id}`);
    if (diff.regressions.length === 0 && diff.newFailures.length === 0) out.push("  no regressions");
  }
  return out.join("\n");
}
