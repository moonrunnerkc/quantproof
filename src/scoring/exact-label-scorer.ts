/**
 * exact-label scorer: classification against a declared label set with
 * alias normalization. The whole (normalized) output must be a label or
 * a declared alias; prose around the label is a wrong answer, because a
 * classifier that cannot emit a bare label fails the task as specified.
 */

import { normalizeText } from './normalize.js';
import { optionalStringRecord, requireStringArray } from './scorer-params.js';
import type { ScoreRecord, ScorerParams } from './scorer-registry.js';

/**
 * Scores a classification output against the declared label set.
 *
 * The output and all labels are normalized (NFKC, case fold, whitespace
 * collapse) before comparison. Aliases map alternative spellings to a
 * canonical label ("bug report" to "bug"); alias keys and values are
 * normalized the same way. Off-label output scores zero and the raw
 * output is preserved in details for debugging.
 *
 * @param output - Raw model output.
 * @param expected - The expected label from the example file.
 * @param params - Requires `labels`: non-empty string array. Optional
 *   `aliases`: object mapping alias to canonical label.
 * @returns Score 1 when the resolved label equals the expected label,
 *   else 0. Details carry the resolved label (or null when off-label)
 *   and the raw output.
 * @throws Error when `labels`/`aliases` params are invalid, when an
 *   alias points at an undeclared label, or when the example's expected
 *   value is not in the label set (both are pack authoring errors).
 */
export function exactLabelScorer(
  output: string,
  expected: unknown,
  params: ScorerParams,
): ScoreRecord {
  const labels = requireStringArray('exact-label', params, 'labels');
  const aliases = optionalStringRecord('exact-label', params, 'aliases');

  const canonical = new Map(labels.map((label) => [normalizeText(label), label]));
  for (const [alias, target] of Object.entries(aliases)) {
    const targetLabel = canonical.get(normalizeText(target));
    if (targetLabel === undefined) {
      throw new Error(
        `scorer "exact-label" alias "${alias}" points at "${target}", which is not in labels; add it to scorer_params.labels or fix the alias`,
      );
    }
    canonical.set(normalizeText(alias), targetLabel);
  }

  if (typeof expected !== 'string' || !canonical.has(normalizeText(expected))) {
    throw new Error(
      `exact-label example has expected value ${JSON.stringify(expected)}, which is not in labels; fix the example file or scorer_params.labels`,
    );
  }
  const expectedLabel = canonical.get(normalizeText(expected));

  const resolved = canonical.get(normalizeText(output)) ?? null;
  if (resolved === null) {
    return {
      score: 0,
      pass: false,
      details: {
        resolvedLabel: null,
        rawOutput: output,
        reason: 'output is not a declared label or alias',
      },
    };
  }

  const match = resolved === expectedLabel;
  return {
    score: match ? 1 : 0,
    pass: match,
    details: { resolvedLabel: resolved, rawOutput: output },
  };
}
