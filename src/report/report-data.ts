/**
 * Report data assembly: turns the store's raw views of one run into
 * everything a renderer needs (aggregates, Pareto frontier, and the
 * recommendation). Pure so the same data feeds the terminal table, the
 * markdown report, and the bundle identically.
 */

import { aggregateCandidates } from './aggregate.js';
import type { CandidateAggregate } from './aggregate.js';
import { paretoFrontier } from './pareto.js';
import type { ParetoResult } from './pareto.js';
import { recommend } from './recommend.js';
import type { Recommendation } from './recommend.js';
import type { CandidateResult, RunRecord, UnitResult } from '../results/record-types.js';

/** Everything a report renderer consumes for one run. */
export interface ReportData {
  readonly run: RunRecord;
  readonly aggregates: readonly CandidateAggregate[];
  readonly pareto: ParetoResult;
  readonly recommendation: Recommendation;
  /** Caveats that must render with the numbers (re-scoring, drift). */
  readonly notes: readonly string[];
}

/** Assembly options. */
export interface ReportDataOptions {
  /** Relative quality tolerance for the recommendation; default 0.02. */
  readonly qualityTolerance?: number;
  /** Caveats to carry into every renderer. */
  readonly notes?: readonly string[];
}

/**
 * Builds report data from one run's stored views.
 *
 * @param run - The run record.
 * @param candidates - The run's candidates with outcomes.
 * @param units - Every unit result of the run. Callers that re-score
 *   from raw outputs swap the score records here before calling.
 * @param options - Tolerance and notes.
 * @returns Data for any renderer; degenerate runs (nothing completed)
 *   produce an honest no-recommendation outcome, never a throw.
 */
export function buildReportData(
  run: RunRecord,
  candidates: readonly CandidateResult[],
  units: readonly UnitResult[],
  options: ReportDataOptions = {},
): ReportData {
  const aggregates = aggregateCandidates(candidates, units);
  return {
    run,
    aggregates,
    pareto: paretoFrontier(aggregates),
    recommendation: recommend(
      aggregates,
      options.qualityTolerance === undefined ? {} : { qualityTolerance: options.qualityTolerance },
    ),
    notes: options.notes ?? [],
  };
}
