/**
 * Scorer types and the by-name registry that task manifests reference.
 *
 * A scorer is a pure function: same output, expected value, and params
 * always produce a byte-identical score record. Nothing in this layer
 * touches the clock, the filesystem, or randomness.
 */

/** The result of scoring one model output against one example. */
export interface ScoreRecord {
  /** Quality in [0, 1]. Gates and binary scorers use exactly 0 or 1. */
  readonly score: number;
  /** Whether this output passes the scorer's own bar. */
  readonly pass: boolean;
  /** Human-readable explanation of how the score came about. */
  readonly details: Record<string, unknown>;
}

/** Free-form scorer parameters as declared in a task manifest. */
export type ScorerParams = Readonly<Record<string, unknown>>;

/**
 * A registered scorer. Must be pure and must never throw on any model
 * output; malformed output is a zero score with an explanation, not an
 * exception. Throwing is reserved for invalid params, which is a task
 * pack authoring error.
 */
export type Scorer = (
  output: string,
  expected: unknown,
  params: ScorerParams,
) => ScoreRecord;

const registry = new Map<string, Scorer>();

/**
 * Registers a scorer under a name that task manifests can reference.
 *
 * @param name - Registry key, e.g. "field-f1".
 * @param scorer - The scorer implementation.
 * @throws Error if the name is already taken, to catch copy-paste
 *   registration mistakes at startup rather than shadowing silently.
 */
export function registerScorer(name: string, scorer: Scorer): void {
  if (registry.has(name)) {
    throw new Error(
      `scorer "${name}" is already registered; pick a different name or remove the duplicate registerScorer call`,
    );
  }
  registry.set(name, scorer);
}

/**
 * Looks up a scorer by the name a task manifest declared.
 *
 * @param name - Registry key from task.yaml.
 * @returns The scorer.
 * @throws Error naming the unknown scorer and listing valid names, so a
 *   pack author can fix the typo without reading source.
 */
export function getScorer(name: string): Scorer {
  const scorer = registry.get(name);
  if (scorer === undefined) {
    const known = [...registry.keys()].sort().join(', ');
    throw new Error(
      `unknown scorer "${name}"; task.yaml must reference one of: ${known}`,
    );
  }
  return scorer;
}

/**
 * Lists all registered scorer names, sorted, for validation messages.
 *
 * @returns Sorted scorer names.
 */
export function listScorers(): readonly string[] {
  return [...registry.keys()].sort();
}
