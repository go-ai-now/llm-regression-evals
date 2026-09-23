import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/errors.js";
import { loadSuite } from "../src/suite/loadSuite.js";
import { renderTemplate } from "../src/suite/template.js";
import { makeSuite, tempDir } from "./helpers.js";

const CONTAINS_OK = { type: "contains", value: "ok" };

describe("renderTemplate", () => {
  it("substitutes variables, tolerating inner whitespace", () => {
    expect(renderTemplate("Hi {{ name }}, {{n}}!", { name: "Ann", n: 2 }, "x")).toBe("Hi Ann, 2!");
  });
  it("throws a ConfigError for an unknown variable", () => {
    expect(() => renderTemplate("{{missing}}", {}, "case a")).toThrow(ConfigError);
  });
});

describe("resolveSuite", () => {
  it("merges default vars and expectations with the case's own", () => {
    const suite = makeSuite({
      system: "Plan: {{plan}}",
      defaults: { vars: { plan: "Free" }, expect: [{ type: "not_contains", value: "error" }] },
      cases: [{ id: "a", vars: { q: "hello" }, expect: [CONTAINS_OK] }],
    });
    const c = suite.cases[0];
    expect(c?.request.system).toBe("Plan: Free");
    expect(c?.request.messages[0]?.content).toBe("hello");
    expect(c?.expectations.map((e) => e.type)).toEqual(["not_contains", "contains"]);
  });

  it("lets a case override the prompt and system", () => {
    const suite = makeSuite({
      system: "S1",
      cases: [{ id: "a", prompt: "custom", system: "S2", expect: [CONTAINS_OK] }],
    });
    expect(suite.cases[0]?.request).toMatchObject({ system: "S2", messages: [{ content: "custom" }] });
  });

  it("defaults the judge model to the suite model", () => {
    expect(makeSuite({ cases: [{ id: "a", vars: { q: "x" }, expect: [CONTAINS_OK] }] }).judgeModel).toBe("test-model");
    expect(
      makeSuite({ judge: { model: "judge" }, cases: [{ id: "a", vars: { q: "x" }, expect: [CONTAINS_OK] }] }).judgeModel,
    ).toBe("judge");
  });

  it.each([
    ["duplicate ids", { cases: [{ id: "a", vars: { q: "x" }, expect: [CONTAINS_OK] }, { id: "a", vars: { q: "x" }, expect: [CONTAINS_OK] }] }],
    ["no expectations", { cases: [{ id: "a", vars: { q: "x" } }] }],
    ["missing template var", { cases: [{ id: "a", expect: [CONTAINS_OK] }] }],
    ["empty cases", { cases: [] }],
    ["bad case id", { cases: [{ id: "has space", vars: { q: "x" }, expect: [CONTAINS_OK] }] }],
    ["unknown scorer", { cases: [{ id: "a", vars: { q: "x" }, expect: [{ type: "vibes" }] }] }],
    ["invalid regex", { cases: [{ id: "a", vars: { q: "x" }, expect: [{ type: "regex", pattern: "(" }] }] }],
    ["invalid JSON schema", { cases: [{ id: "a", vars: { q: "x" }, expect: [{ type: "json_schema", schema: { type: "nope" } }] }] }],
  ])("rejects %s with a ConfigError", (_name, raw) => {
    expect(() => makeSuite(raw)).toThrow(ConfigError);
  });
});

describe("loadSuite", () => {
  it("loads YAML and JSON files and applies a model override", async () => {
    const dir = await tempDir();
    const yamlPath = join(dir, "s.yaml");
    await writeFile(yamlPath, "name: y\nmodel: m1\nprompt: '{{q}}'\ncases:\n  - id: a\n    vars: { q: hi }\n    expect: [{ type: exact, value: hi }]\n");
    const jsonPath = join(dir, "s.json");
    await writeFile(jsonPath, JSON.stringify({ name: "j", model: "m1", prompt: "p", cases: [{ id: "a", expect: [CONTAINS_OK] }] }));

    expect((await loadSuite(yamlPath)).name).toBe("y");
    const overridden = await loadSuite(jsonPath, { model: "m2" });
    expect(overridden.cases[0]?.request.model).toBe("m2");
  });

  it("reports unreadable and unparseable files as ConfigError", async () => {
    const dir = await tempDir();
    await expect(loadSuite(join(dir, "nope.yaml"))).rejects.toThrow(ConfigError);
    const broken = join(dir, "broken.json");
    await writeFile(broken, "{ not json");
    await expect(loadSuite(broken)).rejects.toThrow(ConfigError);
  });
});
