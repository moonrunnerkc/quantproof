/**
 * Prompt template loading and rendering. A template is a plain text
 * file with an {{input}} placeholder; no template engine, because the
 * format needs to stay diffable and trivially authorable.
 */

import { readFileSync } from 'node:fs';

const PLACEHOLDER = '{{input}}';

/**
 * Loads a prompt template file and verifies it has the placeholder.
 *
 * @param path - Absolute path of the template file.
 * @returns The template text, or an error message (never throws) so the
 *   task loader can aggregate it with other pack problems.
 */
export function loadPromptTemplate(
  path: string,
): { readonly ok: true; readonly template: string } | { readonly ok: false; readonly error: string } {
  let template: string;
  try {
    template = readFileSync(path, 'utf8');
  } catch (err) {
    return {
      ok: false,
      error: `cannot read prompt template ${path} (${err instanceof Error ? err.message : String(err)}); check prompt_template in task.yaml`,
    };
  }
  if (!template.includes(PLACEHOLDER)) {
    return {
      ok: false,
      error: `prompt template ${path} has no ${PLACEHOLDER} placeholder; add ${PLACEHOLDER} where the example input belongs`,
    };
  }
  return { ok: true, template };
}

/**
 * Renders a prompt by substituting the example input for every
 * {{input}} placeholder occurrence.
 *
 * @param template - Template text containing {{input}}.
 * @param input - The example's input text.
 * @returns The rendered prompt.
 */
export function renderPrompt(template: string, input: string): string {
  return template.replaceAll(PLACEHOLDER, input);
}
