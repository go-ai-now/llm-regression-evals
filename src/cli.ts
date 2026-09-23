import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { ANTHROPIC_API_KEY_ENV, DEFAULTS, EXIT_CODES } from "./config.js";
import { ConfigError, errorMessage } from "./errors.js";
import { AnthropicProvider, type AnthropicProviderOptions } from "./providers/anthropic.js";
import { readFixtureFile } from "./providers/fixtures.js";
import { RecordingProvider, ReplayProvider } from "./providers/replay.js";
import { compareToBaseline, readBaseline, type BaselineDiff } from "./report/baseline.js";
import { formatCaseLine, formatSummary } from "./report/console.js";
import { toJUnitXml } from "./report/junit.js";
import type { RetryOptions } from "./runner/retry.js";
import { runSuite } from "./runner/runSuite.js";
import { loadSuite } from "./suite/loadSuite.js";
import type { Provider, RunReport } from "./types.js";

export const USAGE = `Usage: llm-regression-evals <suite.yaml|suite.json> [options]

Providers:
  --provider <name>        replay (default, offline) | anthropic (live API)
  --record                 call the live API and (re)write the fixtures file
  --fixtures <path>        fixtures file (default: <suite>.fixtures.json next to the suite)
  --model <id>             override the suite's model

Reports:
  --json <path>            write the full JSON report
  --junit <path>           write JUnit XML for CI test reporting
  --baseline <path>        compare against a previous JSON report
  --save-baseline <path>   write this run as the new baseline
  --fail-on <mode>         auto (default) | failure | regression
                           auto = regression when --baseline is given, else failure
                           regression = a baseline pass now fails, or a new case fails

Execution:
  --concurrency <n>        max cases in flight (default ${DEFAULTS.concurrency})
  --retries <n>            retries per call on 429/5xx/network (default ${DEFAULTS.retries})
  --timeout-ms <n>         per-request timeout for live calls (default ${DEFAULTS.requestTimeoutMs})
  --quiet                  only print the summary
  -h, --help               show this help

Exit codes: 0 ok, 1 failures or regressions, 2 configuration error.`;

type FailOn = "auto" | "failure" | "regression";
const FAIL_ON_MODES: readonly FailOn[] = ["auto", "failure", "regression"];
const PROVIDERS = ["replay", "anthropic"] as const;
type ProviderName = (typeof PROVIDERS)[number];

export interface CliDeps {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Override to inject a fake live provider in tests. */
  createLiveProvider?: (options: AnthropicProviderOptions) => Provider;
  retry?: Partial<Pick<RetryOptions, "sleep" | "random">>;
}

interface CliOptions {
  suitePath: string;
  provider: ProviderName;
  record: boolean;
  fixturesPath: string;
  model: string | undefined;
  jsonPath: string | undefined;
  junitPath: string | undefined;
  baselinePath: string | undefined;
  saveBaselinePath: string | undefined;
  failOn: FailOn;
  concurrency: number;
  retries: number;
  timeoutMs: number;
  quiet: boolean;
}

function parseIntFlag(value: string | undefined, name: string, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw new ConfigError(`--${name} must be an integer >= ${min}, got "${value}"`);
  return parsed;
}

function defaultFixturesPath(suitePath: string): string {
  return join(dirname(suitePath), `${basename(suitePath, extname(suitePath))}.fixtures.json`);
}

/** Parses argv into options; returns null when help was requested. */
export function parseCliArgs(argv: string[]): CliOptions | null {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        provider: { type: "string" },
        record: { type: "boolean", default: false },
        fixtures: { type: "string" },
        model: { type: "string" },
        json: { type: "string" },
        junit: { type: "string" },
        baseline: { type: "string" },
        "save-baseline": { type: "string" },
        "fail-on": { type: "string" },
        concurrency: { type: "string" },
        retries: { type: "string" },
        "timeout-ms": { type: "string" },
        quiet: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new ConfigError(errorMessage(error), { cause: error });
  }
  const { values, positionals } = parsed;
  if (values.help) return null;
  if (positionals.length !== 1) throw new ConfigError("expected exactly one suite file argument");
  const suitePath = positionals[0] as string;

  const providerFlag = values.provider ?? (values.record ? "anthropic" : "replay");
  if (!PROVIDERS.includes(providerFlag as ProviderName)) {
    throw new ConfigError(`--provider must be one of ${PROVIDERS.join(", ")}, got "${providerFlag}"`);
  }
  if (values.record && providerFlag !== "anthropic") throw new ConfigError("--record requires the anthropic provider");

  const failOn = (values["fail-on"] ?? "auto") as FailOn;
  if (!FAIL_ON_MODES.includes(failOn)) throw new ConfigError(`--fail-on must be one of ${FAIL_ON_MODES.join(", ")}`);
  if (failOn === "regression" && values.baseline === undefined) throw new ConfigError("--fail-on regression requires --baseline");

  return {
    suitePath,
    provider: providerFlag as ProviderName,
    record: values.record,
    fixturesPath: values.fixtures ?? defaultFixturesPath(suitePath),
    model: values.model,
    jsonPath: values.json,
    junitPath: values.junit,
    baselinePath: values.baseline,
    saveBaselinePath: values["save-baseline"],
    failOn,
    concurrency: parseIntFlag(values.concurrency, "concurrency", DEFAULTS.concurrency, 1),
    retries: parseIntFlag(values.retries, "retries", DEFAULTS.retries, 0),
    timeoutMs: parseIntFlag(values["timeout-ms"], "timeout-ms", DEFAULTS.requestTimeoutMs, 1),
    quiet: values.quiet,
  };
}

async function writeOutput(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function buildProvider(options: CliOptions, deps: CliDeps): Promise<Provider> {
  if (options.provider === "replay") return ReplayProvider.fromFile(options.fixturesPath);
  const apiKey = deps.env[ANTHROPIC_API_KEY_ENV];
  if (!apiKey) throw new ConfigError(`${ANTHROPIC_API_KEY_ENV} is not set (needed for --provider anthropic / --record)`);
  const liveOptions: AnthropicProviderOptions = { apiKey, timeoutMs: options.timeoutMs };
  const live = deps.createLiveProvider?.(liveOptions) ?? new AnthropicProvider(liveOptions);
  if (!options.record) return live;
  // Seed from the existing file so a partial live failure doesn't wipe earlier recordings.
  const seed = existsSync(options.fixturesPath) ? await readFixtureFile(options.fixturesPath) : undefined;
  return new RecordingProvider(live, seed);
}

function shouldFail(options: CliOptions, report: RunReport, diff: BaselineDiff | undefined): boolean {
  const mode = options.failOn === "auto" ? (diff ? "regression" : "failure") : options.failOn;
  if (mode === "regression") return (diff?.regressions.length ?? 0) > 0 || (diff?.newFailures.length ?? 0) > 0;
  return report.summary.failed + report.summary.errored > 0;
}

/** CLI entry point. Returns the process exit code instead of exiting, for testability. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  try {
    const options = parseCliArgs(argv);
    if (options === null) {
      deps.stdout(`${USAGE}\n`);
      return EXIT_CODES.ok;
    }
    const suite = await loadSuite(options.suitePath, options.model === undefined ? {} : { model: options.model });
    // Read the baseline before spending tokens so a bad path fails fast.
    const baseline = options.baselinePath ? await readBaseline(options.baselinePath) : undefined;
    if (baseline && baseline.suite !== suite.name) {
      throw new ConfigError(
        `baseline ${options.baselinePath} was recorded for suite "${baseline.suite}", not "${suite.name}"`,
      );
    }
    const provider = await buildProvider(options, deps);

    const report = await runSuite(suite, {
      provider,
      concurrency: options.concurrency,
      retry: {
        retries: options.retries,
        baseDelayMs: DEFAULTS.retryBaseDelayMs,
        maxDelayMs: DEFAULTS.retryMaxDelayMs,
        ...deps.retry,
      },
      ...(options.quiet ? {} : { onCaseComplete: (c) => deps.stdout(`${formatCaseLine(c)}\n`) }),
    });

    const diff = baseline ? compareToBaseline(report, baseline) : undefined;
    deps.stdout(`${formatSummary(report, diff)}\n`);

    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.jsonPath) await writeOutput(options.jsonPath, json);
    if (options.saveBaselinePath) await writeOutput(options.saveBaselinePath, json);
    if (options.junitPath) await writeOutput(options.junitPath, toJUnitXml(report, diff));
    if (provider instanceof RecordingProvider) {
      await provider.save(options.fixturesPath);
      const kept = provider.preservedCount > 0 ? ` (kept ${provider.preservedCount} existing)` : "";
      deps.stdout(`Recorded ${provider.recordedCount} fixture(s) to ${options.fixturesPath}${kept}\n`);
    }

    return shouldFail(options, report, diff) ? EXIT_CODES.failed : EXIT_CODES.ok;
  } catch (error) {
    if (error instanceof ConfigError) {
      deps.stderr(`llm-regression-evals: ${error.message}\n\n${USAGE}\n`);
      return EXIT_CODES.configError;
    }
    deps.stderr(`llm-regression-evals: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return EXIT_CODES.configError;
  }
}
