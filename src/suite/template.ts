import { ConfigError } from "../errors.js";

export type TemplateVars = Record<string, string | number | boolean>;

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Renders `{{name}}` placeholders. Unknown placeholders are a configuration
 * error: silently rendering an empty string would hide a broken test case.
 */
export function renderTemplate(template: string, vars: TemplateVars, where: string): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.hasOwn(vars, name)) {
      throw new ConfigError(`${where}: template variable "{{${name}}}" has no value in vars`);
    }
    return String(vars[name]);
  });
}
