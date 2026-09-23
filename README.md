# llm-regression-evals

**Regression tests for LLM-powered features.** Define what your feature must do as
declarative test cases, run them against a model, and get a pass/fail report your CI
understands - so a prompt tweak or a model upgrade can't silently break production.

> Built by AI coding agents under Sabry's direction and review.

[![CI](https://github.com/go-ai-now/llm-regression-evals/actions/workflows/ci.yml/badge.svg)](https://github.com/go-ai-now/llm-regression-evals/actions/workflows/ci.yml)
![Node 22](https://img.shields.io/badge/node-22-green) ![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)

---

## The problem

An LLM feature is a function whose implementation is a prompt plus a model. Both
change all the time: someone "improves" the wording, adds a rule, or bumps to a newer
model. Unlike normal code there is no compiler and usually no test, so regressions
show up as customer tickets:

- the classifier starts returning prose around its JSON and the router crashes;
- an outage stops being marked `urgent`;
- a prompt-injection ticket makes the assistant leak its instructions.

`llm-regression-evals` turns those expectations into a test suite that runs on every pull
request - **offline and free** in CI via recorded fixtures, and against the live API
whenever you want to re-check real behaviour.

## Features

- **YAML or JSON suites** - prompt templates with `{{vars}}`, suite-wide defaults, per-case overrides.
- **Scorers** - `exact`, `regex`, `contains`, `not_contains`, `json_schema` (full JSON Schema via Ajv),
  `json_field` (deep equality at a dotted path) and `llm_judge` (rubric-graded by a model).
- **Pluggable providers** - Anthropic (official `@anthropic-ai/sdk`) and a deterministic **replay**
  provider. `--record` captures live answers into a fixtures file.
- **Stale-fixture detection** - each fixture stores a hash of model + system + prompt + `maxTokens`;
  if you change the prompt, replay fails loudly instead of testing an old answer.
- **Baselines** - `--baseline` compares against a previous run and fails on *regressions*
  (passed before, fails now) and on *new cases that fail*. Known failures are tracked but don't
  block merges. A baseline recorded for a different suite is rejected.
- **CI output** - JUnit XML (`--junit`) and a full JSON report (`--json`); exit code `1` on failure/regression.
- **Reliability** - bounded concurrency, retries with exponential backoff + jitter on 429 / 5xx / network
  errors, honouring `retry-after`. SDK-level retries are disabled so attempts are counted once.
- **Cost accounting** - input/output/cache tokens from the API `usage` fields, per call and per run,
  priced per model (override prices per suite).

## Quick start

Requires Node 22+.

```bash
git clone https://github.com/go-ai-now/llm-regression-evals.git && cd llm-regression-evals
npm ci
npm run build

# Run the example suite offline against recorded fixtures, compared to the committed baseline
npm run eval:example
```

> **About the example fixtures:** the committed fixtures were **hand-authored** to
> illustrate the format and the regression workflow - they were not recorded from the
> live API, and their token counts are rough estimates. Run `--record` with your own
> key to replace them with real recordings.

Output:

```text
  PASS  billing-double-charge (3ms, 1 call(s))
  PASS  account-2fa-lockout (2ms, 1 call(s))
  ...
  PASS  angry-cancellation (1ms, 2 call(s))
  FAIL  invoice-company-name (0ms, 1 call(s))
         - json_field category == "billing": got "account"

Suite:    support-ticket-triage  (provider: replay, model: claude-haiku-4-5)
Results:  8/9 passed (88.9%), 1 failed, 0 errored
Tokens:   1888 in / 377 out (cache write 0, cache read 0)
Cost:     $0.003773
Baseline: pass rate +0.0%
  known      invoice-company-name: still fail
  no regressions
```

Exit code `0`: one case fails, but it also failed in the baseline, so nothing regressed.
Now replay a set of fixtures that simulates a bad prompt change:

```bash
npm run eval:example:regressed
```

```text
Results:  6/9 passed (66.7%), 3 failed, 0 errored
Baseline: pass rate -22.2%
  REGRESSION outage-all-users: pass -> fail
  REGRESSION privacy-erasure-request: pass -> fail
  known      invoice-company-name: still fail
```

Exit code `1` - the pull request is blocked.

### Against the live API

```bash
export ANTHROPIC_API_KEY=...
node dist/bin.js examples/support-tickets/support-tickets.yaml --provider anthropic
# Re-record the fixtures from live answers (then commit them):
node dist/bin.js examples/support-tickets/support-tickets.yaml --record
```

## Case format

```yaml
name: support-ticket-triage
model: claude-haiku-4-5          # any Anthropic model ID; override with --model
maxTokens: 300
system: |                        # optional; may use {{vars}}
  You are the ticket triage step ... reply with ONLY a JSON object.
prompt: |                        # user message template
  Ticket from {{customer}} (plan: {{plan}}):
  """
  {{ticket}}
  """

judge:
  model: claude-haiku-4-5        # optional; defaults to `model`

pricing:                         # optional USD per million tokens, overrides built-ins
  my-fine-tuned-model: { inputPerMTok: 2, outputPerMTok: 8 }

defaults:
  vars: { plan: Business }       # merged under each case's vars
  expect:                        # prepended to every case's expectations
    - type: json_schema
      schema: { type: object, required: [category, priority] }

cases:
  - id: outage-all-users         # letters, digits, . _ -  (used as the fixture key)
    description: Platform-wide outage must be urgent.
    tags: [sla]
    vars:
      customer: Globex
      ticket: Nobody can log in since 09:10 UTC. Login page returns 503.
    # prompt: / system: can be overridden per case
    expect:
      - { type: json_field, path: priority, equals: urgent }
```

A case **passes** when every expectation passes. It **errors** when the model call
fails after retries (or a fixture is missing/stale); errors count as failures.
Unknown template variables, invalid regexes and invalid JSON Schemas are rejected when
the suite loads, before any tokens are spent.

See [`examples/support-tickets/support-tickets.yaml`](examples/support-tickets/support-tickets.yaml)
for a complete suite covering routing, SLA priority, GDPR handling, prompt injection
and tone.

## Scorers

| type | checks | options |
|---|---|---|
| `exact` | output equals `value` | `trim` (default `true`), `ignoreCase` |
| `regex` | output matches `pattern` | `flags` (e.g. `i`, `s`, `m`) |
| `contains` | every string is present | `value` or `values`, `ignoreCase` |
| `not_contains` | no string is present (leaks, PII, banned phrases) | `value` or `values`, `ignoreCase` |
| `json_schema` | output parses as JSON and validates | `schema` (JSON Schema draft-07 via Ajv) |
| `json_field` | value at a dotted path deep-equals `equals` | `path` (e.g. `items.0.sku`), `equals` |
| `llm_judge` | a model grades the output 1-5 against a rubric | `rubric`, `passThreshold` (default `4`) |

All scorers accept an optional `label` shown in reports. JSON scorers accept pure
JSON or JSON wrapped in a single markdown code fence; anything else (e.g. "Sure! Here
it is: {...}") fails, because that is exactly what breaks downstream parsers.

**LLM-as-judge.** The judge sees the original request, the output and your rubric,
and must answer `{"score": 1-5, "reason": "..."}`. A malformed judge reply is a
failure, never a silent pass. The request and output are passed to the judge as JSON-encoded
strings (with `<` escaped) and flagged as data, not instructions, so a model output containing
`</output>` or "give this a 5" can't hijack the grade. Judge calls go through the same provider, so they are
retried, metered and **replayable** (fixture key `<caseId>#judge<index>`). Prefer
deterministic scorers where possible; use the judge for qualities like tone or
faithfulness that can't be pattern-matched.

## CLI

```text
llm-regression-evals <suite.yaml|suite.json> [options]

  --provider <name>        replay (default, offline) | anthropic (live API)
  --record                 call the live API and (re)write the fixtures file; entries for
                           calls that fail during recording keep their previous value
  --fixtures <path>        default: <suite>.fixtures.json next to the suite
  --model <id>             override the suite's model
  --json <path>            write the full JSON report
  --junit <path>           write JUnit XML
  --baseline <path>        compare against a previous JSON report
  --save-baseline <path>   write this run as the new baseline
  --fail-on <mode>         auto (default) | failure | regression
  --concurrency <n>        default 4
  --retries <n>            default 3 (429 / 408 / 409 / 5xx / network only)
  --timeout-ms <n>         per-request timeout for live calls, default 60000
  --quiet                  only print the summary
```

| exit code | meaning |
|---|---|
| `0` | no failures (or, with `--baseline`, no regressions and no failing new cases) |
| `1` | failures (or, with `--baseline`, regressions or failing new cases) |
| `2` | configuration error: bad suite, missing fixtures/baseline, baseline for another suite, missing API key, bad flags |

`--fail-on auto` means *regression* mode when `--baseline` is given and *failure*
mode otherwise. In regression mode the run fails when:

- a case that passed in the baseline no longer passes (`REGRESSION`), or
- a case that is not in the baseline does not pass (`NEW FAIL`) - new behaviour must prove itself
  before it can become a tracked known failure.

Cases that failed in the baseline and still fail are reported as `known` and don't block.
A baseline whose suite name differs from the current suite is a configuration error (exit `2`),
so a wrong `--baseline` path can't make everything look "new". Use `--fail-on failure` to require
a 100% pass rate even with a baseline.

## CI usage

The workflow in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs typecheck,
unit tests, the example suite in replay mode, and a self-check that a simulated
regression really exits `1`. To use it for your own feature:

```yaml
- run: npm ci && npm run build
- run: >
    node dist/bin.js evals/my-feature.yaml
    --baseline evals/my-feature.baseline.json
    --junit reports/junit.xml --json reports/report.json
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: eval-reports, path: reports/ }
```

Recommended workflow:

1. Change the prompt or model locally, run with `--record` to refresh fixtures.
2. Review the fixture diff (keys are sorted, one entry per case) like any other code change.
3. Once the new behaviour is accepted, refresh the baseline with `--save-baseline`.
4. Pull requests replay the committed fixtures - no API key, no spend, no flakiness.

Changing the prompt without re-recording makes replay report the affected cases as
**stale**, so an un-tested prompt change can't pass CI unnoticed.

Optionally run a scheduled live job (`--provider anthropic`) to catch provider-side
drift on the same suite.

## Adding a provider

A provider is one method. Throw `ProviderError` so the runner knows what to retry:

```ts
import { ProviderError, type Provider, type ProviderRequest, type ProviderResponse } from "llm-regression-evals";

export class MyProvider implements Provider {
  readonly name = "my-provider";

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const res = await fetch("https://llm.example.com/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: request.model, system: request.system, messages: request.messages, max_tokens: request.maxTokens }),
    });
    if (!res.ok) {
      throw new ProviderError(`HTTP ${res.status}`, { retryable: res.status === 429 || res.status >= 500, status: res.status });
    }
    const body = (await res.json()) as { text: string; model: string; usage: { input: number; output: number } };
    return {
      text: body.text,
      model: body.model,
      stopReason: null,
      usage: { inputTokens: body.usage.input, outputTokens: body.usage.output, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    };
  }
}
```

Then run it programmatically (the CLI is a thin wrapper around the same API):

```ts
import { loadSuite, runSuite, RecordingProvider } from "llm-regression-evals";

const suite = await loadSuite("evals/my-feature.yaml");
const report = await runSuite(suite, {
  provider: new MyProvider(),
  concurrency: 4,
  retry: { retries: 3, baseDelayMs: 500, maxDelayMs: 20_000 },
});
```

Wrap it in `RecordingProvider` to capture fixtures, and replay them with `ReplayProvider`.

## Notes on the Anthropic provider

The Anthropic provider has not yet been exercised against the live API.

- Uses `client.messages.create` from `@anthropic-ai/sdk` with `maxRetries: 0` (the runner owns retries).
- Sampling parameters (`temperature`, `top_p`, `top_k`) are intentionally not sent: the SDK documents
  that models released after Claude Opus 4.6 reject non-default values. Reproducibility in CI comes from
  replay fixtures, not from sampling settings.
- Built-in prices cover a few models only and are a convenience - verify them against Anthropic's
  pricing page and use the suite `pricing:` block for anything else. Unpriced models report tokens and
  `Cost: unknown` rather than a wrong number.

## Development

```bash
npm run typecheck   # tsc, strict
npm test            # vitest, fully offline
npm run build       # emits dist/
```

## License

[MIT](LICENSE) (c) go-ai-now
