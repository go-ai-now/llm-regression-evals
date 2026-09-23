import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/errors.js";
import { compareToBaseline, readBaseline, type Baseline } from "../src/report/baseline.js";
import { escapeXml, toJUnitXml } from "../src/report/junit.js";
import { summarise } from "../src/runner/runSuite.js";
import type { CaseResult, CaseStatus, RunReport } from "../src/types.js";
import { tempDir } from "./helpers.js";

function caseResult(id: string, status: CaseStatus): CaseResult {
  return {
    id,
    tags: [],
    status,
    output: status === "error" ? null : `out-${id}`,
    scores: status === "fail" ? [{ type: "exact", label: "exact", pass: false, reason: 'got "x" & <y>' }] : [],
    calls: [],
    durationMs: 1500,
    ...(status === "error" ? { error: "model call failed" } : {}),
  };
}

function report(statuses: Record<string, CaseStatus>, suite = "s"): RunReport {
  const cases = Object.entries(statuses).map(([id, s]) => caseResult(id, s));
  return {
    schemaVersion: 1,
    suite,
    provider: "replay",
    model: "m",
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 2000,
    summary: summarise(cases),
    cost: {
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      totalUsd: null,
      unpricedModels: ["m"],
    },
    cases,
  };
}

const asBaseline = (r: RunReport): Baseline => r;

describe("compareToBaseline", () => {
  const baseline = asBaseline(report({ a: "pass", b: "pass", c: "fail", d: "fail", gone: "pass" }));

  it("classifies regressions, fixes, known failures, new and removed cases", () => {
    const diff = compareToBaseline(report({ a: "pass", b: "error", c: "pass", d: "fail", fresh: "fail" }), baseline);
    expect(diff.regressions).toEqual([{ id: "b", baseline: "pass", current: "error" }]);
    expect(diff.fixed.map((f) => f.id)).toEqual(["c"]);
    expect(diff.stillFailing.map((f) => f.id)).toEqual(["d"]);
    expect(diff.newCases).toEqual(["fresh"]);
    expect(diff.newFailures).toEqual(["fresh"]);
    expect(diff.removedCases).toEqual(["gone"]);
    expect(diff.suiteMismatch).toBe(false);
  });

  it("does not count a new failing case or a removed case as a regression", () => {
    const diff = compareToBaseline(report({ a: "pass", b: "pass", c: "fail", d: "fail", brandnew: "fail" }), baseline);
    expect(diff.regressions).toEqual([]);
    expect(diff.newFailures).toEqual(["brandnew"]);
  });

  it("does not flag a new passing case", () => {
    const diff = compareToBaseline(report({ a: "pass", b: "pass", c: "fail", d: "fail", brandnew: "pass" }), baseline);
    expect(diff.newCases).toEqual(["brandnew"]);
    expect(diff.newFailures).toEqual([]);
  });

  it("flags a suite-name mismatch", () => {
    expect(compareToBaseline(report({ a: "pass" }, "other"), baseline).suiteMismatch).toBe(true);
  });
});

describe("readBaseline", () => {
  it("round-trips a JSON report and rejects garbage", async () => {
    const dir = await tempDir();
    const good = join(dir, "good.json");
    await writeFile(good, JSON.stringify(report({ a: "pass" })));
    expect((await readBaseline(good)).cases).toEqual([expect.objectContaining({ id: "a", status: "pass" })]);

    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ hello: "world" }));
    await expect(readBaseline(bad)).rejects.toThrow(ConfigError);
    await expect(readBaseline(join(dir, "missing.json"))).rejects.toThrow(ConfigError);
  });
});

describe("toJUnitXml", () => {
  it("emits one testcase per case with failures, errors and regression markers", () => {
    const current = report({ ok: "pass", bad: "fail", boom: "error" });
    const diff = compareToBaseline(current, asBaseline(report({ ok: "pass", bad: "pass", boom: "fail" })));
    const xml = toJUnitXml(current, diff);
    expect(xml).toContain('tests="3" failures="1" errors="1"');
    expect(xml).toContain('<testcase classname="s" name="ok" time="1.500" />');
    expect(xml).toContain('<failure message="REGRESSION vs baseline. 1 expectation(s) failed">');
    expect(xml).toContain('<error message="model call failed">');
    expect(xml).toContain("got &quot;x&quot; &amp; &lt;y&gt;");
  });

  it("marks failing new cases distinctly from regressions", () => {
    const current = report({ ok: "pass", fresh: "fail" });
    const xml = toJUnitXml(current, compareToBaseline(current, asBaseline(report({ ok: "pass" }))));
    expect(xml).toContain('<failure message="NEW CASE FAILING (not in baseline). 1 expectation(s) failed">');
  });

  it("escapes XML special and illegal control characters", () => {
    expect(escapeXml(`<a href="x">'&'</a>\u0001`)).toBe("&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;");
  });
});
