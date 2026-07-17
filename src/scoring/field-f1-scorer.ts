/**
 * field-f1 scorer: per-field comparison of extracted JSON against the
 * expected object over the declared key fields, with shared
 * normalization, reported as precision/recall/F1. The workhorse for
 * extraction tasks.
 */

import { extractJson } from './extract-json.js';
import { normalizeScalar } from './normalize.js';
import { requireStringArray } from './scorer-params.js';
import type { ScoreRecord, ScorerParams } from './scorer-registry.js';

type FieldStatus = 'match' | 'mismatch' | 'missing';

/** Compares two field values after normalizing scalars on both sides. */
function fieldsEqual(actual: unknown, expected: unknown): boolean {
  const isScalar = (v: unknown): v is string | number | boolean | null =>
    v === null || ['string', 'number', 'boolean'].includes(typeof v);
  if (isScalar(actual) && isScalar(expected)) {
    return normalizeScalar(actual) === normalizeScalar(expected);
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return (
      actual.length === expected.length &&
      actual.every((item, i) => fieldsEqual(item, expected[i]))
    );
  }
  if (
    typeof actual === 'object' && actual !== null && !Array.isArray(actual) &&
    typeof expected === 'object' && expected !== null && !Array.isArray(expected)
  ) {
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    const aKeys = Object.keys(a).sort();
    const eKeys = Object.keys(e).sort();
    return (
      aKeys.length === eKeys.length &&
      aKeys.every((k, i) => k === eKeys[i] && fieldsEqual(a[k], e[k]))
    );
  }
  return false;
}

/**
 * Scores extracted JSON field-by-field against the expected object.
 *
 * Over the declared `key_fields`: a field present in the output with a
 * normalized value equal to the expected value is a true positive; a
 * present-but-wrong value counts against both precision and recall; an
 * absent field counts against recall only. Score is F1; pass requires
 * every key field to match.
 *
 * @param output - Raw model output, expected to contain a JSON object.
 * @param expected - The expected object from the example file.
 * @param params - Requires `key_fields`: non-empty string array.
 * @returns F1 as score, with per-field status plus precision, recall,
 *   and F1 in details. Non-JSON output scores 0 with the reason in
 *   details.
 * @throws Error when `params.key_fields` is invalid or the example's
 *   expected value is not an object; both are pack authoring errors,
 *   never model failures.
 */
export function fieldF1Scorer(
  output: string,
  expected: unknown,
  params: ScorerParams,
): ScoreRecord {
  const keyFields = requireStringArray('field-f1', params, 'key_fields');

  if (typeof expected !== 'object' || expected === null || Array.isArray(expected)) {
    throw new Error(
      `field-f1 example has expected value ${JSON.stringify(expected)}, but this scorer needs an object with the key fields as properties; fix the example file`,
    );
  }
  const expectedRecord = expected as Record<string, unknown>;

  const extraction = extractJson(output);
  if (!extraction.ok || typeof extraction.value !== 'object' || extraction.value === null || Array.isArray(extraction.value)) {
    return {
      score: 0,
      pass: false,
      details: {
        extractionNeeded: extraction.extractionNeeded,
        reason: extraction.ok
          ? 'output JSON is not an object, so there are no fields to compare'
          : `output is not JSON: ${extraction.error ?? 'unknown parse failure'}`,
        fields: Object.fromEntries(keyFields.map((f) => [f, 'missing' satisfies FieldStatus])),
        precision: 0,
        recall: 0,
        f1: 0,
      },
    };
  }
  const actual = extraction.value as Record<string, unknown>;

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  const fields: Record<string, FieldStatus> = {};
  for (const field of keyFields) {
    if (!(field in actual)) {
      fields[field] = 'missing';
      falseNegatives += 1;
    } else if (fieldsEqual(actual[field], expectedRecord[field])) {
      fields[field] = 'match';
      truePositives += 1;
    } else {
      fields[field] = 'mismatch';
      falsePositives += 1;
      falseNegatives += 1;
    }
  }

  const precision =
    truePositives + falsePositives === 0 ? 0 : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0 ? 0 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    score: f1,
    pass: truePositives === keyFields.length,
    details: {
      extractionNeeded: extraction.extractionNeeded,
      fields,
      precision,
      recall,
      f1,
    },
  };
}
