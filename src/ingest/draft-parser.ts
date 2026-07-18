/**
 * Turns raw drafting-model output into a checked pack draft. Every
 * problem is collected in one pass and phrased for the repair round, so
 * the drafting model (or the user) can fix all of it at once. This is
 * the trust boundary between a model's proposal and the files ingest
 * writes; nothing here executes or scores anything.
 */

import { extractJson } from '../scoring/extract-json.js';
import { MIN_DRAFT_EXAMPLES } from './draft-prompt.js';

/** One proposed example, input plus machine-checkable expected value. */
export interface DraftExample {
  readonly input: string;
  readonly expected: unknown;
}

/** A parsed, structurally checked pack proposal. */
export interface PackDraft {
  readonly name: string;
  readonly type: string;
  readonly scorer: string;
  readonly scorerParams: Readonly<Record<string, unknown>>;
  readonly prompt: string;
  readonly examples: readonly DraftExample[];
}

/** Outcome of parsing a draft: the draft or every error found. */
export type DraftParse =
  | { readonly ok: true; readonly draft: PackDraft }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kebab(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function checkExamples(errors: string[], raw: unknown): DraftExample[] {
  if (!Array.isArray(raw)) {
    errors.push('"examples" must be an array of { "input", "expected" } objects');
    return [];
  }
  const seen = new Set<string>();
  const examples: DraftExample[] = [];
  raw.forEach((entry: unknown, index) => {
    if (!isRecord(entry)) {
      errors.push(`examples[${String(index)}] must be an object with "input" and "expected"`);
      return;
    }
    const input = entry['input'];
    if (typeof input !== 'string' || input.trim() === '') {
      errors.push(`examples[${String(index)}].input must be a non-empty string`);
      return;
    }
    if (!('expected' in entry)) {
      errors.push(`examples[${String(index)}] is missing "expected"`);
      return;
    }
    if (seen.has(input)) {
      return;
    }
    seen.add(input);
    examples.push({ input, expected: entry['expected'] });
  });
  if (examples.length < MIN_DRAFT_EXAMPLES) {
    errors.push(
      `only ${String(examples.length)} distinct valid examples; propose at least ${String(MIN_DRAFT_EXAMPLES)} (20 or more preferred)`,
    );
  }
  return examples;
}

function checkScorerFit(
  errors: string[],
  scorer: string,
  params: Readonly<Record<string, unknown>>,
  examples: readonly DraftExample[],
): void {
  if (scorer === 'exact-label') {
    const labels = params['labels'];
    if (!Array.isArray(labels) || labels.length === 0 || !labels.every((l) => typeof l === 'string')) {
      errors.push('scorer_params.labels must be a non-empty array of strings for exact-label');
      return;
    }
    const offenders = examples
      .filter((e) => typeof e.expected !== 'string' || !labels.includes(e.expected))
      .map((e) => JSON.stringify(e.expected));
    if (offenders.length > 0) {
      errors.push(
        `every expected value must be one of the declared labels; not in the set: ${[...new Set(offenders)].slice(0, 5).join(', ')}`,
      );
    }
  }
  if (scorer === 'field-f1') {
    const keyFields = params['key_fields'];
    if (!Array.isArray(keyFields) || keyFields.length === 0 || !keyFields.every((f) => typeof f === 'string')) {
      errors.push('scorer_params.key_fields must be a non-empty array of strings for field-f1');
      return;
    }
    const missing = examples.filter((e) => {
      const expected = e.expected;
      return !isRecord(expected) || keyFields.some((f) => !(f in expected));
    });
    if (missing.length > 0) {
      errors.push(
        `${String(missing.length)} example(s) have an expected object missing one of the key fields (${keyFields.join(', ')}); every expected must carry all of them`,
      );
    }
  }
  if (scorer === 'numeric-tolerance') {
    const tolerance = params['tolerance'];
    if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
      errors.push('scorer_params.tolerance must be a non-negative number for numeric-tolerance');
    }
    if (examples.some((e) => typeof e.expected !== 'number')) {
      errors.push('every expected value must be a number for numeric-tolerance');
    }
  }
}

/**
 * Parses and structurally checks a drafting model's response.
 *
 * @param output - Raw model output; JSON is extracted from fences or
 *   prose the same way scorers do it.
 * @param knownScorers - Registered scorer names.
 * @returns The checked draft, or every error found, phrased so a
 *   repair round can fix all of them at once. Never throws.
 */
export function parseDraft(output: string, knownScorers: readonly string[]): DraftParse {
  const extraction = extractJson(output);
  if (!extraction.ok) {
    return {
      ok: false,
      errors: [`the response must be a single JSON object; ${extraction.error ?? 'no JSON value found'}`],
    };
  }
  const raw = extraction.value;
  if (!isRecord(raw)) {
    return { ok: false, errors: ['the response must be a JSON object, not an array or scalar'] };
  }
  const errors: string[] = [];
  const rawName = raw['name'];
  const name = typeof rawName === 'string' ? kebab(rawName) : '';
  if (name === '') {
    errors.push('"name" must be a non-empty string (it becomes the kebab-case pack name)');
  }
  const type = raw['type'];
  if (typeof type !== 'string' || type.trim() === '') {
    errors.push('"type" must be a non-empty string, e.g. "classification"');
  }
  const scorer = raw['scorer'];
  if (typeof scorer !== 'string' || !knownScorers.includes(scorer)) {
    errors.push(`"scorer" must be one of: ${knownScorers.join(', ')}`);
  }
  const params = isRecord(raw['scorer_params']) ? raw['scorer_params'] : {};
  const prompt = raw['prompt'];
  if (typeof prompt !== 'string' || !prompt.includes('{{input}}')) {
    errors.push('"prompt" must be a string containing the literal placeholder {{input}}');
  }
  const examples = checkExamples(errors, raw['examples']);
  if (typeof scorer === 'string' && knownScorers.includes(scorer)) {
    checkScorerFit(errors, scorer, params, examples);
  }
  if (
    errors.length > 0 ||
    typeof type !== 'string' ||
    typeof scorer !== 'string' ||
    typeof prompt !== 'string'
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    draft: { name, type: type.trim(), scorer, scorerParams: params, prompt, examples },
  };
}

/**
 * Best-effort recovery of a failed draft so it can still be written to
 * disk for hand-fixing: invalid pieces get placeholders, structurally
 * broken examples are dropped. Returns null when the output holds no
 * JSON object at all, the one case with nothing to salvage.
 *
 * @param output - Raw model output that failed parseDraft.
 * @param knownScorers - Registered scorer names, for the fallback.
 * @returns A writable draft, or null.
 */
export function salvageDraft(output: string, knownScorers: readonly string[]): PackDraft | null {
  const extraction = extractJson(output);
  if (!extraction.ok || !isRecord(extraction.value)) {
    return null;
  }
  const raw = extraction.value;
  const rawName = raw['name'];
  const name = typeof rawName === 'string' && kebab(rawName) !== '' ? kebab(rawName) : 'drafted-task';
  const type = typeof raw['type'] === 'string' && raw['type'].trim() !== '' ? raw['type'].trim() : 'unknown';
  const scorer =
    typeof raw['scorer'] === 'string' && knownScorers.includes(raw['scorer'])
      ? raw['scorer']
      : (knownScorers[0] ?? 'exact-label');
  const prompt =
    typeof raw['prompt'] === 'string' && raw['prompt'].includes('{{input}}')
      ? raw['prompt']
      : 'Replace this drafted prompt; it must contain {{input}}.\n\nInput:\n{{input}}';
  const examples: DraftExample[] = [];
  if (Array.isArray(raw['examples'])) {
    const seen = new Set<string>();
    for (const entry of raw['examples'] as unknown[]) {
      if (isRecord(entry) && typeof entry['input'] === 'string' && entry['input'].trim() !== '' &&
          'expected' in entry && !seen.has(entry['input'])) {
        seen.add(entry['input']);
        examples.push({ input: entry['input'], expected: entry['expected'] });
      }
    }
  }
  return {
    name,
    type,
    scorer,
    scorerParams: isRecord(raw['scorer_params']) ? raw['scorer_params'] : {},
    prompt,
    examples,
  };
}
