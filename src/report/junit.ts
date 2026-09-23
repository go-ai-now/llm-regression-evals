import type { BaselineDiff } from "./baseline.js";
import type { CaseResult, RunReport } from "../types.js";

const MS_PER_SECOND = 1000;

export function escapeXml(text: string): string {
  return (
    text
      // Strip characters that are illegal in XML 1.0 (control chars except tab/LF/CR).
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

function seconds(ms: number): string {
  return (ms / MS_PER_SECOND).toFixed(3);
}

function testCase(suite: string, c: CaseResult, prefix: string): string {
  const open = `    <testcase classname="${escapeXml(suite)}" name="${escapeXml(c.id)}" time="${seconds(c.durationMs)}"`;
  const failedScores = c.scores.filter((s) => !s.pass);
  const details = failedScores.map((s) => `${s.label}: ${s.reason}`).join("\n");
  if (c.status === "pass") return `${open} />`;
  if (c.status === "error") {
    const message = `${prefix}${c.error ?? "error"}`;
    return `${open}>\n      <error message="${escapeXml(message)}">${escapeXml(message)}</error>\n    </testcase>`;
  }
  const message = `${prefix}${failedScores.length} expectation(s) failed`;
  const body = `${details}\n\nOutput:\n${c.output ?? ""}`;
  return `${open}>\n      <failure message="${escapeXml(message)}">${escapeXml(body)}</failure>\n    </testcase>`;
}

/** Renders a JUnit XML document understood by GitHub, GitLab, Jenkins, CircleCI. */
export function toJUnitXml(report: RunReport, diff?: BaselineDiff): string {
  const prefixes = new Map<string, string>([
    ...(diff?.regressions.map((r): [string, string] => [r.id, "REGRESSION vs baseline. "]) ?? []),
    ...(diff?.newFailures.map((id): [string, string] => [id, "NEW CASE FAILING (not in baseline). "]) ?? []),
  ]);
  const { summary } = report;
  const cases = report.cases.map((c) => testCase(report.suite, c, prefixes.get(c.id) ?? "")).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="llm-regression-evals" tests="${summary.total}" failures="${summary.failed}" errors="${summary.errored}" time="${seconds(report.durationMs)}">`,
    `  <testsuite name="${escapeXml(report.suite)}" tests="${summary.total}" failures="${summary.failed}" errors="${summary.errored}" time="${seconds(report.durationMs)}" timestamp="${report.startedAt}">`,
    "    <properties>",
    `      <property name="provider" value="${escapeXml(report.provider)}" />`,
    `      <property name="model" value="${escapeXml(report.model)}" />`,
    `      <property name="inputTokens" value="${report.cost.usage.inputTokens}" />`,
    `      <property name="outputTokens" value="${report.cost.usage.outputTokens}" />`,
    `      <property name="costUsd" value="${report.cost.totalUsd ?? "unknown"}" />`,
    "    </properties>",
    cases,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}
