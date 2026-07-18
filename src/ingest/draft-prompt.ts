/**
 * The instructions handed to the drafting model. Ingest asks a model to
 * read a freeform task document and propose a complete pack as one JSON
 * object; everything it proposes is then re-validated by the same
 * strict loader hand-written packs go through, so this prompt aims the
 * model but never gets trusted.
 */

/** Character budget for the source document inside the draft prompt. */
export const SOURCE_CHAR_BUDGET = 24000;

/** Fewest examples a draft must propose to be worth validating. */
export const MIN_DRAFT_EXAMPLES = 10;

const SCORER_GUIDE = `- "exact-label": classification into a closed label set. scorer_params: {"labels": [...], "aliases": {...}} (aliases optional). Each example's "expected" is one label.
- "field-f1": extraction of named fields. scorer_params: {"key_fields": [...]}. Each "expected" is an object with those fields.
- "numeric-tolerance": a single numeric answer. scorer_params: {"tolerance": <absolute number>}. Each "expected" is a number.
- "pattern": output must contain declared substrings. scorer_params: {"patterns": [...]}. "expected" is unused but must be present (use the matched string).
- "json-schema": output must satisfy a JSON Schema. scorer_params: {"schema": {...inline schema...}}. "expected" is unused but must be present.`;

/** What a repair round feeds back: the failed draft and its errors. */
export interface DraftRepair {
  readonly previousDraft: string;
  readonly errors: readonly string[];
}

/**
 * Builds the drafting prompt for a source document.
 *
 * @param sourceText - The freeform document; truncated to the char
 *   budget with a note when longer.
 * @param sourceName - Basename shown to the model for context.
 * @param repair - Present on repair rounds: the prior draft and the
 *   validation errors it must fix.
 * @returns The complete prompt string.
 */
export function buildDraftPrompt(
  sourceText: string,
  sourceName: string,
  repair?: DraftRepair,
): string {
  const truncated = sourceText.length > SOURCE_CHAR_BUDGET;
  const body = truncated ? sourceText.slice(0, SOURCE_CHAR_BUDGET) : sourceText;
  const parts = [
    'You design evaluation task packs for quantproof, a tool that measures how well local language models handle a user\'s real task. Read the user\'s document below and propose ONE task pack that turns it into a deterministically checkable benchmark.',
    '',
    'Respond with a single JSON object, nothing else:',
    '{',
    '  "name": "<kebab-case-task-name>",',
    '  "type": "<one word, e.g. classification or extraction>",',
    '  "scorer": "<one of the scorers below>",',
    '  "scorer_params": { ... },',
    '  "prompt": "<the instruction sent to the model per example; must contain the literal placeholder {{input}} exactly where the example input goes>",',
    '  "examples": [ { "input": "<realistic input text>", "expected": <machine-checkable answer> }, ... ]',
    '}',
    '',
    'Scorers (pick the one that fits the document best):',
    SCORER_GUIDE,
    '',
    'Rules:',
    `- Propose at least 20 examples (${String(MIN_DRAFT_EXAMPLES)} is the hard floor). Every input must be distinct and realistic for the document's domain.`,
    '- Every "expected" value must be mechanically checkable by the chosen scorer. No free-text answers, no explanations.',
    '- If the document describes workflows or categories rather than input/answer pairs, derive a classification task over the document\'s own categories and write realistic inputs for each.',
    '- Temperature-0 models will run this, so the prompt must demand a bare answer with no surrounding prose.',
  ];
  if (repair !== undefined) {
    parts.push(
      '',
      'Your previous draft failed validation. Fix every error and respond with the complete corrected JSON object.',
      'Previous draft:',
      repair.previousDraft,
      'Errors:',
      ...repair.errors.map((e) => `- ${e}`),
    );
  }
  parts.push(
    '',
    `Document (${sourceName}${truncated ? ', truncated to fit' : ''}):`,
    body,
  );
  return parts.join('\n');
}
