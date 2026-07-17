/**
 * Task pack manifest (task.yaml) types and validation.
 *
 * Validation is strict and collects every problem in one pass; task
 * packs are the community-facing surface and a fix-one-rerun-repeat
 * loop here would kill contributions.
 */

/** Generation parameters a task declares for every candidate model. */
export interface GenerationParams {
  /** Context window to request, in tokens. */
  readonly context: number;
  /** Generation cap per example, in tokens. */
  readonly max_tokens: number;
  /** Sampling temperature; 0 for deterministic scoring runs. */
  readonly temperature: number;
  /** Sampler seed, applied where the backend honors it. */
  readonly seed: number;
  /** Repetitions per example, for variance reporting. */
  readonly runs_per_example: number;
}

/** A gate scorer declaration: must pass or the example scores zero. */
export interface GateDeclaration {
  /** Registered scorer name. */
  readonly scorer: string;
  /** Params for the gate scorer; defaults to empty. */
  readonly scorer_params: Readonly<Record<string, unknown>>;
}

/** A validated task.yaml manifest. Paths are as written, unresolved. */
export interface TaskManifest {
  readonly name: string;
  readonly type: string;
  readonly scorer: string;
  readonly scorer_params: Readonly<Record<string, unknown>>;
  readonly generation: GenerationParams;
  /** Path to the prompt template file, relative to the pack dir. */
  readonly prompt_template: string;
  /** Path to the examples directory, relative to the pack dir. */
  readonly examples_dir: string;
  readonly gates: readonly GateDeclaration[];
}

/** Outcome of manifest validation: a manifest or every error found. */
export type ManifestValidation =
  | { readonly ok: true; readonly manifest: TaskManifest }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkString(
  errors: string[],
  source: Record<string, unknown>,
  key: string,
  hint: string,
): string | undefined {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`"${key}" must be a non-empty string; ${hint}`);
    return undefined;
  }
  return value;
}

function checkNumber(
  errors: string[],
  source: Record<string, unknown>,
  key: string,
  constraint: 'positive-integer' | 'integer' | 'non-negative',
): number | undefined {
  const value = source[key];
  const bad = (why: string): undefined => {
    errors.push(`"generation.${key}" ${why}; set it to a valid value in task.yaml`);
    return undefined;
  };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return bad('must be a number');
  }
  if (constraint !== 'non-negative' && !Number.isInteger(value)) {
    return bad('must be an integer');
  }
  if (constraint === 'positive-integer' && value < 1) {
    return bad('must be at least 1');
  }
  if (constraint === 'non-negative' && value < 0) {
    return bad('must be zero or greater');
  }
  return value;
}

function checkParams(
  errors: string[],
  source: Record<string, unknown>,
  key: string,
  where: string,
): Readonly<Record<string, unknown>> {
  const value = source[key];
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    errors.push(`"${where}" must be a mapping of param names to values; fix it in task.yaml`);
    return {};
  }
  return value;
}

function checkGeneration(
  errors: string[],
  source: Record<string, unknown>,
): GenerationParams | undefined {
  const raw = source['generation'];
  if (!isRecord(raw)) {
    errors.push(
      '"generation" must be a mapping with context, max_tokens, temperature, seed, and runs_per_example; add it to task.yaml',
    );
    return undefined;
  }
  const context = checkNumber(errors, raw, 'context', 'positive-integer');
  const maxTokens = checkNumber(errors, raw, 'max_tokens', 'positive-integer');
  const temperature = checkNumber(errors, raw, 'temperature', 'non-negative');
  const seed = checkNumber(errors, raw, 'seed', 'integer');
  const runsPerExample = checkNumber(errors, raw, 'runs_per_example', 'positive-integer');
  if (
    context === undefined ||
    maxTokens === undefined ||
    temperature === undefined ||
    seed === undefined ||
    runsPerExample === undefined
  ) {
    return undefined;
  }
  return {
    context,
    max_tokens: maxTokens,
    temperature,
    seed,
    runs_per_example: runsPerExample,
  };
}

function checkGates(
  errors: string[],
  source: Record<string, unknown>,
  knownScorers: readonly string[],
): readonly GateDeclaration[] {
  const raw = source['gates'];
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    errors.push('"gates" must be a list of { scorer, scorer_params } entries; fix it in task.yaml');
    return [];
  }
  const gates: GateDeclaration[] = [];
  raw.forEach((entry: unknown, index) => {
    if (!isRecord(entry)) {
      errors.push(`"gates[${String(index)}]" must be a mapping with a "scorer" key; fix it in task.yaml`);
      return;
    }
    const scorer = checkString(
      errors,
      entry,
      'scorer',
      `set gates[${String(index)}].scorer to one of: ${knownScorers.join(', ')}`,
    );
    if (scorer === undefined) {
      return;
    }
    if (!knownScorers.includes(scorer)) {
      errors.push(
        `"gates[${String(index)}].scorer" is "${scorer}", which is not a known scorer; use one of: ${knownScorers.join(', ')}`,
      );
      return;
    }
    gates.push({
      scorer,
      scorer_params: checkParams(errors, entry, 'scorer_params', `gates[${String(index)}].scorer_params`),
    });
  });
  return gates;
}

/**
 * Validates a parsed task.yaml document against the manifest spec.
 *
 * Collects every error rather than stopping at the first; each error
 * names the offending field and says how to fix it.
 *
 * @param raw - The YAML document as parsed (unknown shape).
 * @param knownScorers - Registered scorer names, for validating the
 *   `scorer` field and gate entries with a helpful list in the message.
 * @returns The validated manifest, or the full error list. Never throws.
 */
export function validateManifest(
  raw: unknown,
  knownScorers: readonly string[],
): ManifestValidation {
  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: ['task.yaml must be a YAML mapping at the top level; see docs/task-packs.md for the format'],
    };
  }

  const errors: string[] = [];
  const name = checkString(errors, raw, 'name', 'give the task a kebab-case name like "invoice-extraction"');
  const type = checkString(errors, raw, 'type', 'declare the task type, e.g. "extraction" or "classification"');
  const scorer = checkString(errors, raw, 'scorer', `set it to one of: ${knownScorers.join(', ')}`);
  if (scorer !== undefined && !knownScorers.includes(scorer)) {
    errors.push(`"scorer" is "${scorer}", which is not a known scorer; use one of: ${knownScorers.join(', ')}`);
  }
  const scorerParams = checkParams(errors, raw, 'scorer_params', 'scorer_params');
  const generation = checkGeneration(errors, raw);
  const promptTemplate = checkString(errors, raw, 'prompt_template', 'point it at the prompt file, e.g. "./prompt.md"');
  const examplesDir = checkString(errors, raw, 'examples_dir', 'point it at the examples directory, e.g. "./examples"');
  const gates = checkGates(errors, raw, knownScorers);

  if (
    errors.length > 0 ||
    name === undefined ||
    type === undefined ||
    scorer === undefined ||
    generation === undefined ||
    promptTemplate === undefined ||
    examplesDir === undefined
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    manifest: {
      name,
      type,
      scorer,
      scorer_params: scorerParams,
      generation,
      prompt_template: promptTemplate,
      examples_dir: examplesDir,
      gates,
    },
  };
}
