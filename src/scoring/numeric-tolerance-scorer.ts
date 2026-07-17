/**
 * numeric-tolerance scorer: parses the first number out of model output
 * (currency symbols, thousands separators, and percent signs are fine)
 * and compares it to the expected number within a declared absolute or
 * relative tolerance.
 */

import { parseFirstNumber } from './normalize.js';
import { optionalChoice, requireNumber } from './scorer-params.js';
import type { ScoreRecord, ScorerParams } from './scorer-registry.js';

/**
 * Scores a numeric answer within tolerance.
 *
 * @param output - Raw model output; the first numeric token is used.
 *   Numbers written as words do not parse and score zero.
 * @param expected - The expected number from the example file.
 * @param params - Requires `tolerance`: non-negative finite number.
 *   Optional `mode`: "absolute" (default) or "relative". Relative
 *   tolerance is a fraction of |expected| (0.02 means within 2%).
 * @returns Score 1 when |actual - expected| is within tolerance, else
 *   0. Details carry both values, the raw matched token, the computed
 *   difference, and the allowed difference.
 * @throws Error when params are invalid or the example's expected value
 *   is not a finite number (pack authoring errors).
 */
export function numericToleranceScorer(
  output: string,
  expected: unknown,
  params: ScorerParams,
): ScoreRecord {
  const tolerance = requireNumber('numeric-tolerance', params, 'tolerance');
  if (tolerance < 0) {
    throw new Error(
      'scorer "numeric-tolerance" param "tolerance" must be zero or positive; fix scorer_params.tolerance in task.yaml',
    );
  }
  const mode = optionalChoice(
    'numeric-tolerance',
    params,
    'mode',
    ['absolute', 'relative'],
    'absolute',
  );

  if (typeof expected !== 'number' || !Number.isFinite(expected)) {
    throw new Error(
      `numeric-tolerance example has expected value ${JSON.stringify(expected)}, which is not a finite number; fix the example file`,
    );
  }

  const parsed = parseFirstNumber(output);
  if (parsed === null) {
    return {
      score: 0,
      pass: false,
      details: {
        expected,
        actual: null,
        rawOutput: output,
        reason: 'no numeric token found in output (numbers written as words do not count)',
      },
    };
  }

  const allowed = mode === 'absolute' ? tolerance : tolerance * Math.abs(expected);
  const difference = Math.abs(parsed.value - expected);
  const pass = difference <= allowed;

  return {
    score: pass ? 1 : 0,
    pass,
    details: {
      expected,
      actual: parsed.value,
      rawToken: parsed.raw,
      mode,
      difference,
      allowedDifference: allowed,
    },
  };
}
