/**
 * Gate composition: a task declares one primary scorer plus optional
 * gate scorers. Failing any gate zeroes the result regardless of the
 * primary score, and the composed record names the gate that failed.
 */

import type { ScoreRecord, Scorer, ScorerParams } from './scorer-registry.js';

/** A scorer paired with the params the task manifest declared for it. */
export interface BoundScorer {
  /** Registry name, used in details to say which gate failed. */
  readonly name: string;
  readonly scorer: Scorer;
  readonly params: ScorerParams;
}

/**
 * Runs gates in declared order, then the primary scorer, and composes
 * one record.
 *
 * The primary scorer always runs, even when a gate fails, so its raw
 * score stays visible in details; only the top-level score is zeroed.
 * All gate records and the primary record are preserved under details
 * for report drill-down.
 *
 * @param output - Raw model output.
 * @param expected - The expected value from the example file.
 * @param primary - The task's primary scorer with its params.
 * @param gates - Gate scorers in declared order; may be empty.
 * @returns When every gate passes: the primary score and pass, with
 *   `failedGate: null` in details. When a gate fails: score 0, pass
 *   false, and `failedGate` naming the first failing gate.
 * @throws Whatever the underlying scorers throw on invalid params.
 */
export function scoreWithGates(
  output: string,
  expected: unknown,
  primary: BoundScorer,
  gates: readonly BoundScorer[],
): ScoreRecord {
  const gateRecords = gates.map((gate) => ({
    name: gate.name,
    record: gate.scorer(output, expected, gate.params),
  }));
  const primaryRecord = primary.scorer(output, expected, primary.params);
  const failed = gateRecords.find((gate) => !gate.record.pass) ?? null;

  return {
    score: failed === null ? primaryRecord.score : 0,
    pass: failed === null && primaryRecord.pass,
    details: {
      failedGate: failed === null ? null : failed.name,
      primary: { name: primary.name, record: primaryRecord },
      gates: gateRecords,
    },
  };
}
