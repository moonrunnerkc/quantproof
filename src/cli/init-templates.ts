/**
 * File contents written by quantproof init. Every generated file says
 * what to edit, and the example placeholders carry a "replace_me" key
 * that the example loader rejects on purpose, so a scaffolded pack
 * cannot run until real examples exist.
 */

/** Scorer-specific scaffold pieces. */
interface ScorerScaffold {
  /** scorer_params (and gates) YAML, already indented for task.yaml. */
  readonly paramsYaml: string;
  /** schema.json content, when the scorer or its gate references one. */
  readonly schemaJson: string | null;
  /** JSON-encoded placeholder for the examples' "expected" value. */
  readonly expectedPlaceholder: string;
  /** One line describing the output the prompt must ask for. */
  readonly outputHint: string;
}

const SCAFFOLDS: Readonly<Record<string, ScorerScaffold>> = {
  'field-f1': {
    paramsYaml: [
      'scorer_params:',
      '  # Fields compared against "expected" after normalization of case,',
      '  # whitespace, and number formats. Edit to your real field names.',
      '  key_fields: [field_a, field_b]',
      '',
      '# Gates: every gate must pass or the example scores 0. The json-schema',
      '# gate rejects non-JSON output before field comparison; edit schema.json',
      '# to match your fields.',
      'gates:',
      '  - scorer: json-schema',
      '    scorer_params:',
      '      schema: ./schema.json',
    ].join('\n'),
    schemaJson: JSON.stringify(
      {
        type: 'object',
        properties: { field_a: { type: 'string' }, field_b: { type: 'number' } },
        required: ['field_a', 'field_b'],
      },
      null,
      2,
    ),
    expectedPlaceholder: '{ "field_a": "the exact value the model must extract", "field_b": 0 }',
    outputHint: 'a JSON object with exactly the fields declared in schema.json',
  },
  'exact-label': {
    paramsYaml: [
      'scorer_params:',
      '  # The closed label set. The whole (normalized) output must be one',
      '  # of these or one of the aliases.',
      '  labels: [label_a, label_b, other]',
      '  # Optional: map common phrasings onto canonical labels.',
      '  aliases: {}',
    ].join('\n'),
    schemaJson: null,
    expectedPlaceholder: '"label_a"',
    outputHint: 'exactly one label from the declared set, nothing else',
  },
  'json-schema': {
    paramsYaml: [
      'scorer_params:',
      '  # The output must parse as JSON and satisfy this schema.',
      '  schema: ./schema.json',
    ].join('\n'),
    schemaJson: JSON.stringify(
      { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      null,
      2,
    ),
    expectedPlaceholder: '{}',
    outputHint: 'a JSON object satisfying schema.json (expected is unused by this scorer)',
  },
  pattern: {
    paramsYaml: [
      'scorer_params:',
      '  # Strings the output must contain (mode: contains) or regexes it',
      '  # must match (mode: regex). match: all requires every pattern.',
      '  patterns: ["a substring the output must contain"]',
      '  mode: contains',
      '  match: all',
    ].join('\n'),
    schemaJson: null,
    expectedPlaceholder: '""',
    outputHint: 'text containing the declared patterns (expected is unused by this scorer)',
  },
  'numeric-tolerance': {
    paramsYaml: [
      'scorer_params:',
      '  # Absolute tolerance around the expected number.',
      '  tolerance: 0.01',
    ].join('\n'),
    schemaJson: null,
    expectedPlaceholder: '42',
    outputHint: 'a number (prose around it is tolerated; the first number is compared)',
  },
};

/** Scorers the scaffolder knows how to parameterize. */
export function scaffoldedScorers(): readonly string[] {
  return Object.keys(SCAFFOLDS).sort();
}

function scaffoldFor(scorer: string): ScorerScaffold {
  const scaffold = SCAFFOLDS[scorer];
  if (scaffold === undefined) {
    throw new Error(
      `no init scaffold for scorer "${scorer}"; use one of: ${scaffoldedScorers().join(', ')}`,
    );
  }
  return scaffold;
}

/**
 * task.yaml content for a new pack.
 *
 * @param name - Task pack name.
 * @param type - Task type label.
 * @param scorer - Primary scorer; must be a scaffolded scorer.
 * @returns Commented YAML.
 * @throws Error when the scorer has no scaffold.
 */
export function taskYamlTemplate(name: string, type: string, scorer: string): string {
  const scaffold = scaffoldFor(scorer);
  return [
    '# Task pack manifest. Format spec: docs/task-packs.md.',
    '# Check your edits with: quantproof validate <this directory>',
    `name: ${name}`,
    `type: ${type}`,
    '',
    `scorer: ${scorer}`,
    scaffold.paramsYaml,
    '',
    '# Generation parameters applied to every candidate model.',
    'generation:',
    '  context: 4096        # context window requested from the backend',
    '  max_tokens: 512      # cap per example; too low truncates output and tanks scores',
    '  temperature: 0       # keep at 0: scoring assumes deterministic output',
    '  seed: 42',
    '  runs_per_example: 3  # repetitions; the report shows score spread across them',
    '',
    'prompt_template: ./prompt.md',
    'examples_dir: ./examples',
    '',
  ].join('\n');
}

/**
 * prompt.md content: the text sent to the model with {{input}}
 * substituted per example.
 *
 * @param scorer - Primary scorer, to state the required output shape.
 * @returns The template text.
 */
export function promptTemplate(scorer: string): string {
  const scaffold = scaffoldFor(scorer);
  return [
    'Edit this file: it is sent to the model verbatim (with {{input}} replaced',
    "by each example's input), so replace these two instruction lines with your",
    'real task description.',
    '',
    `Respond with ${scaffold.outputHint}.`,
    '',
    'Input:',
    '{{input}}',
    '',
  ].join('\n');
}

/**
 * schema.json content for scorers that declare one; null otherwise.
 *
 * @param scorer - Primary scorer.
 * @returns JSON text or null.
 */
export function schemaTemplate(scorer: string): string | null {
  return scaffoldFor(scorer).schemaJson;
}

/**
 * A placeholder example that fails validation on purpose: the
 * "replace_me" key makes the example loader reject it with a message
 * telling the user to supply a real example.
 *
 * @param scorer - Primary scorer, for a plausible expected shape.
 * @returns JSON text for one example file.
 */
export function examplePlaceholder(scorer: string): string {
  const scaffold = scaffoldFor(scorer);
  return [
    '{',
    '  "replace_me": "Fill in a real input and expected value, then delete this key.",',
    '  "input": "one real input for your task, exactly as the model should receive it",',
    `  "expected": ${scaffold.expectedPlaceholder}`,
    '}',
    '',
  ].join('\n');
}
