import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { ConfigError, errorMessage } from "../errors.js";
import { compileJsonSchema } from "../scorers/json.js";
import type { EvalCase, EvalSuite, Expectation } from "../types.js";
import { SuiteFileSchema, type CaseFile, type SuiteFile } from "./schema.js";
import { renderTemplate } from "./template.js";

const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

/** Fails fast on expectations that could only ever error at run time. */
function validateExpectation(e: Expectation, where: string): void {
  if (e.type === "regex") {
    try {
      new RegExp(e.pattern, e.flags);
    } catch (error) {
      throw new ConfigError(`${where}: invalid regex (${errorMessage(error)})`, { cause: error });
    }
  }
  if (e.type === "json_schema") compileJsonSchema(e.schema, where);
}

function resolveCase(file: SuiteFile, c: CaseFile): EvalCase {
  const where = `case "${c.id}"`;
  const template = c.prompt ?? file.prompt;
  if (template === undefined) throw new ConfigError(`${where}: no prompt (set suite.prompt or case.prompt)`);

  const vars = { ...file.defaults.vars, ...c.vars };
  const systemTemplate = c.system ?? file.system;
  const expectations = [...file.defaults.expect, ...c.expect];
  if (expectations.length === 0) throw new ConfigError(`${where}: no expectations (set case.expect or defaults.expect)`);
  expectations.forEach((e, i) => validateExpectation(e, `${where} expectation #${i}`));

  const system = systemTemplate === undefined ? undefined : renderTemplate(systemTemplate, vars, `${where} system`);
  return {
    id: c.id,
    ...(c.description === undefined ? {} : { description: c.description }),
    tags: c.tags,
    request: {
      model: file.model,
      ...(system === undefined ? {} : { system }),
      messages: [{ role: "user", content: renderTemplate(template, vars, `${where} prompt`) }],
      maxTokens: file.maxTokens,
    },
    expectations,
  };
}

/** Validates an already-parsed suite document and resolves it into runnable cases. */
export function resolveSuite(raw: unknown, sourcePath: string, overrides: { model?: string } = {}): EvalSuite {
  const parsed = SuiteFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`invalid suite file ${sourcePath}:\n${formatZodIssues(parsed.error)}`);
  }
  const file: SuiteFile = overrides.model === undefined ? parsed.data : { ...parsed.data, model: overrides.model };

  const seen = new Set<string>();
  for (const c of file.cases) {
    if (seen.has(c.id)) throw new ConfigError(`duplicate case id "${c.id}" in ${sourcePath}`);
    seen.add(c.id);
  }

  return {
    name: file.name,
    sourcePath,
    model: file.model,
    judgeModel: file.judge.model ?? file.model,
    cases: file.cases.map((c) => resolveCase(file, c)),
    pricing: file.pricing,
  };
}

/** Reads a `.yaml`, `.yml` or `.json` suite file from disk. */
export async function loadSuite(path: string, overrides: { model?: string } = {}): Promise<EvalSuite> {
  const absolute = resolve(path);
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read suite file ${absolute}: ${errorMessage(error)}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = YAML_EXTENSIONS.has(extname(absolute).toLowerCase()) ? parseYaml(text) : JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`cannot parse suite file ${absolute}: ${errorMessage(error)}`, { cause: error });
  }
  return resolveSuite(raw, absolute, overrides);
}
