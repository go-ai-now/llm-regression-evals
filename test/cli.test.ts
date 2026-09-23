import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { main, type CliDeps } from "../src/cli.js";
import { EXIT_CODES } from "../src/config.js";
import { ProviderError } from "../src/errors.js";
import { hashRequest, readFixtureFile, writeFixtureFile } from "../src/providers/fixtures.js";
import { loadSuite } from "../src/suite/loadSuite.js";
import { FakeProvider, response, tempDir } from "./helpers.js";

const SUITE_YAML = `
name: cli-suite
model: test-model
prompt: "Say {{word}}"
cases:
  - id: one
    vars: { word: alpha }
    expect: [{ type: contains, value: alpha }]
  - id: two
    vars: { word: beta }
    expect: [{ type: contains, value: beta }]
`;

interface Captured {
  deps: CliDeps;
  out: () => string;
  err: () => string;
}

function capture(env: Record<string, string> = {}, extra: Partial<CliDeps> = {}): Captured {
  let out = "";
  let err = "";
  return {
    deps: {
      env,
      stdout: (t) => void (out += t),
      stderr: (t) => void (err += t),
      retry: { sleep: async () => undefined },
      ...extra,
    },
    out: () => out,
    err: () => err,
  };
}

let dir: string;
let suitePath: string;
let fixturesPath: string;

/** Writes fixtures answering each case id with the given text. */
async function writeAnswers(answers: Record<string, string>, path = fixturesPath): Promise<void> {
  const suite = await loadSuite(suitePath);
  const entries = Object.fromEntries(
    suite.cases.map((c) => [c.id, { requestHash: hashRequest(c.request), response: response(answers[c.id] ?? "") }]),
  );
  await writeFixtureFile(path, { version: 1, entries });
}

beforeEach(async () => {
  dir = await tempDir();
  suitePath = join(dir, "suite.yaml");
  fixturesPath = join(dir, "suite.fixtures.json");
  await writeFile(suitePath, SUITE_YAML);
});

describe("CLI exit codes", () => {
  it("exits 0 when every case passes (replay is the default provider)", async () => {
    await writeAnswers({ one: "alpha", two: "beta" });
    const c = capture();
    expect(await main([suitePath], c.deps)).toBe(EXIT_CODES.ok);
    expect(c.out()).toContain("2/2 passed");
  });

  it("exits 1 when a case fails and there is no baseline", async () => {
    await writeAnswers({ one: "alpha", two: "wrong" });
    expect(await main([suitePath, "--quiet"], capture().deps)).toBe(EXIT_CODES.failed);
  });

  it("with a baseline, exits 0 for known failures and 1 for regressions", async () => {
    const baseline = join(dir, "baseline.json");
    await writeAnswers({ one: "alpha", two: "wrong" });
    // Recording a baseline with a failing case still exits 1 (fail-on failure).
    expect(await main([suitePath, "--save-baseline", baseline], capture().deps)).toBe(EXIT_CODES.failed);

    const known = capture();
    expect(await main([suitePath, "--baseline", baseline], known.deps)).toBe(EXIT_CODES.ok);
    expect(known.out()).toContain("known      two");

    await writeAnswers({ one: "nope", two: "wrong" });
    const regressed = capture();
    expect(await main([suitePath, "--baseline", baseline], regressed.deps)).toBe(EXIT_CODES.failed);
    expect(regressed.out()).toContain("REGRESSION one: pass -> fail");

    // --fail-on failure is stricter than the baseline default.
    await writeAnswers({ one: "alpha", two: "wrong" });
    expect(await main([suitePath, "--baseline", baseline, "--fail-on", "failure"], capture().deps)).toBe(EXIT_CODES.failed);
  });

  it("with a baseline, a failing NEW case blocks but a passing new case does not", async () => {
    const baseline = join(dir, "baseline.json");
    await writeAnswers({ one: "alpha", two: "beta" });
    expect(await main([suitePath, "--save-baseline", baseline], capture().deps)).toBe(EXIT_CODES.ok);

    const withThree = `${SUITE_YAML}  - id: three\n    vars: { word: gamma }\n    expect: [{ type: contains, value: gamma }]\n`;
    await writeFile(suitePath, withThree);

    await writeAnswers({ one: "alpha", two: "beta", three: "gamma" });
    expect(await main([suitePath, "--baseline", baseline], capture().deps)).toBe(EXIT_CODES.ok);

    await writeAnswers({ one: "alpha", two: "beta", three: "wrong" });
    const blocked = capture();
    expect(await main([suitePath, "--baseline", baseline], blocked.deps)).toBe(EXIT_CODES.failed);
    expect(blocked.out()).toContain("NEW FAIL   three");
  });

  it("exits 2 when the baseline belongs to a different suite", async () => {
    await writeAnswers({ one: "alpha", two: "beta" });
    const baseline = join(dir, "baseline.json");
    expect(await main([suitePath, "--save-baseline", baseline], capture().deps)).toBe(EXIT_CODES.ok);
    await writeFile(suitePath, SUITE_YAML.replace("name: cli-suite", "name: other-suite"));
    await writeAnswers({ one: "alpha", two: "beta" });
    const c = capture();
    expect(await main([suitePath, "--baseline", baseline], c.deps)).toBe(EXIT_CODES.configError);
    expect(c.err()).toContain('recorded for suite "cli-suite"');
  });

  it("exits 1 when a fixture is stale because the prompt changed", async () => {
    await writeAnswers({ one: "alpha", two: "beta" });
    await writeFile(suitePath, SUITE_YAML.replace('"Say {{word}}"', '"Please say {{word}}"'));
    const c = capture();
    expect(await main([suitePath], c.deps)).toBe(EXIT_CODES.failed);
    expect(c.out()).toContain("stale");
  });

  it.each([
    ["no suite argument", []],
    ["unknown flag", ["SUITE", "--bogus"]],
    ["bad provider", ["SUITE", "--provider", "openai"]],
    ["bad concurrency", ["SUITE", "--concurrency", "0"]],
    ["fail-on regression without baseline", ["SUITE", "--fail-on", "regression"]],
    ["missing fixtures file", ["SUITE", "--fixtures", "/nonexistent/f.json"]],
    ["missing baseline file", ["SUITE", "--baseline", "/nonexistent/b.json"]],
    ["live provider without API key", ["SUITE", "--provider", "anthropic"]],
  ])("exits 2 on configuration error: %s", async (_name, args) => {
    await writeAnswers({ one: "alpha", two: "beta" });
    const c = capture();
    expect(await main(args.map((a) => (a === "SUITE" ? suitePath : a)), c.deps)).toBe(EXIT_CODES.configError);
    expect(c.err()).toContain("llm-regression-evals:");
  });

  it("prints help and exits 0", async () => {
    const c = capture();
    expect(await main(["--help"], c.deps)).toBe(EXIT_CODES.ok);
    expect(c.out()).toContain("Usage: llm-regression-evals");
  });
});

describe("CLI outputs", () => {
  it("writes JSON and JUnit reports, creating parent directories", async () => {
    await writeAnswers({ one: "alpha", two: "wrong" });
    const json = join(dir, "out", "nested", "report.json");
    const junit = join(dir, "out", "junit.xml");
    await main([suitePath, "--json", json, "--junit", junit, "--quiet"], capture().deps);

    const report = JSON.parse(await readFile(json, "utf8"));
    expect(report.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(await readFile(junit, "utf8")).toContain('<testsuite name="cli-suite" tests="2" failures="1"');
  });

  it("--record calls the live provider and writes fixtures that replay cleanly", async () => {
    const live = new FakeProvider(async (req) => response(req.messages[0]?.content.replace("Say ", "") ?? ""));
    const rec = capture({ ANTHROPIC_API_KEY: "test-key" }, { createLiveProvider: () => live });
    expect(await main([suitePath, "--record"], rec.deps)).toBe(EXIT_CODES.ok);
    expect(live.calls).toHaveLength(2);
    expect(rec.out()).toContain("Recorded 2 fixture(s)");
    expect(Object.keys((await readFixtureFile(fixturesPath)).entries)).toEqual(["one", "two"]);

    expect(await main([suitePath], capture().deps)).toBe(EXIT_CODES.ok);
  });

  it("--record keeps existing fixtures for cases whose live call failed", async () => {
    await writeAnswers({ one: "alpha", two: "beta" });
    const before = await readFixtureFile(fixturesPath);

    const flaky = new FakeProvider(async (req) => {
      if (req.messages[0]?.content === "Say beta") throw new ProviderError("bad request", { retryable: false, status: 400 });
      return response("alpha (re-recorded)");
    });
    const rec = capture({ ANTHROPIC_API_KEY: "test-key" }, { createLiveProvider: () => flaky });
    expect(await main([suitePath, "--record", "--quiet"], rec.deps)).toBe(EXIT_CODES.failed);
    expect(rec.out()).toContain("Recorded 1 fixture(s)");
    expect(rec.out()).toContain("kept 1 existing");

    const after = await readFixtureFile(fixturesPath);
    expect(after.entries.one?.response.text).toBe("alpha (re-recorded)");
    expect(after.entries.two).toEqual(before.entries.two);
  });
});
