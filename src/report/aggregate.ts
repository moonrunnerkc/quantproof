/**
 * Aggregation over unit results: quality with its spread across
 * repetitions, latency medians with their spread, and per-candidate
 * aggregates (VRAM delta, gate outcomes, flags) for the report table
 * and the recommendation. Variance is a first-class output here, never
 * averaged away.
 */

import type {
  CandidateRecord,
  CandidateResult,
  CandidateStatus,
  UnitResult,
} from '../results/record-types.js';

/** Min and max of a sample set; rendered wherever a mean or median appears. */
export interface Spread {
  readonly min: number;
  readonly max: number;
}

/** Mean quality of one full repetition pass over the examples. */
export interface RepetitionQuality {
  readonly repetition: number;
  readonly meanScore: number;
}

/** Everything the report table needs for one candidate. */
export interface RunSummary {
  readonly completed: number;
  readonly failed: number;
  readonly pending: number;
  /** Units skipped without running (an OOM candidate's remainder). */
  readonly skipped: number;
  /** Mean score over all completed units. Null with zero completions. */
  readonly meanScore: number | null;
  /** Fraction of completed units that passed. Null with zero completions. */
  readonly passRate: number | null;
  /** Per-repetition means, ascending by repetition. */
  readonly repetitions: readonly RepetitionQuality[];
  /** Spread of the per-repetition means; null with zero completions. */
  readonly scoreSpread: Spread | null;
  readonly ttftMedianMs: number | null;
  /** Min and max TTFT across completed units; null without samples. */
  readonly ttftSpreadMs: Spread | null;
  readonly tokensPerSecondMedian: number | null;
  /** Min and max tokens/sec across completed units; null without samples. */
  readonly tokensPerSecondSpread: Spread | null;
  readonly wallMsTotal: number;
  /**
   * True when every example's output is byte-identical across all of
   * its completed repetitions; false means the backend did not honor
   * the fixed seed. Null when no example completed more than once.
   */
  readonly outputsDeterministic: boolean | null;
  /**
   * Completed units whose generation stopped at the max_tokens budget
   * (done reason "length") without emitting any visible output. Their
   * zero scores measure truncation, not task quality: reasoning-style
   * models can spend the whole budget on thinking tokens.
   */
  readonly truncatedEmptyCount: number;
}

/**
 * Median of a numeric list.
 *
 * @param values - Sample values in any order.
 * @returns The median, or null for an empty list.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] as number) + upper) / 2;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function spreadOf(values: readonly number[]): Spread | null {
  return values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Aggregates a run's unit results into the report summary.
 *
 * @param results - All unit results of a run, any status.
 * @returns The summary; degenerate inputs (nothing completed) produce
 *   nulls, not fabricated numbers.
 */
export function summarizeRun(results: readonly UnitResult[]): RunSummary {
  const done = results.filter((r) => r.status === 'completed' && r.score !== null);
  const scores = done.map((r) => r.score?.score ?? 0);

  const byRepetition = new Map<number, number[]>();
  const byExample = new Map<string, string[]>();
  for (const result of done) {
    const rep = byRepetition.get(result.unit.repetition) ?? [];
    rep.push(result.score?.score ?? 0);
    byRepetition.set(result.unit.repetition, rep);
    const outputs = byExample.get(result.unit.exampleId) ?? [];
    outputs.push(result.generation?.output ?? '');
    byExample.set(result.unit.exampleId, outputs);
  }
  const repetitions = [...byRepetition.entries()]
    .map(([repetition, values]) => ({ repetition, meanScore: mean(values) }))
    .sort((a, b) => a.repetition - b.repetition);

  const multiRepExamples = [...byExample.values()].filter((outputs) => outputs.length > 1);
  const outputsDeterministic =
    multiRepExamples.length === 0
      ? null
      : multiRepExamples.every((outputs) => outputs.every((o) => o === outputs[0]));

  const ttfts = done
    .map((r) => r.generation?.ttftMs)
    .filter((v): v is number => typeof v === 'number');
  const rates = done
    .map((r) => r.generation?.tokensPerSecond)
    .filter((v): v is number => typeof v === 'number');

  return {
    completed: done.length,
    failed: results.filter((r) => r.status === 'failed').length,
    pending: results.filter((r) => r.status === 'pending').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    meanScore: scores.length === 0 ? null : mean(scores),
    passRate: done.length === 0 ? null : done.filter((r) => r.score?.pass === true).length / done.length,
    repetitions,
    scoreSpread: spreadOf(repetitions.map((r) => r.meanScore)),
    ttftMedianMs: median(ttfts),
    ttftSpreadMs: spreadOf(ttfts),
    tokensPerSecondMedian: median(rates),
    tokensPerSecondSpread: spreadOf(rates),
    wallMsTotal: done.reduce((sum, r) => sum + (r.generation?.wallMs ?? 0), 0),
    outputsDeterministic,
    truncatedEmptyCount: done.filter(
      (r) => r.generation?.doneReason === 'length' && (r.generation?.output ?? '').trim() === '',
    ).length,
  };
}

/** One candidate's full aggregate: summary, VRAM, gates, and flags. */
export interface CandidateAggregate {
  readonly candidate: CandidateRecord;
  readonly status: CandidateStatus;
  readonly statusReason: string | null;
  readonly offloadSuspectReason: string | null;
  readonly summary: RunSummary;
  readonly measuredPeakMib: number | null;
  readonly predictedPeakMib: number | null;
  /** (measured - predicted) / predicted, percent; null when either side is missing. */
  readonly vramDeltaPercent: number | null;
  /**
   * True when every completed unit passed every gate scorer (trivially
   * true for packs without gates); false when any completed unit failed
   * a gate; null with zero completions.
   */
  readonly gatesPassed: boolean | null;
  /** Completed units per failing gate name, for nearest-miss reporting. */
  readonly gateFailureCounts: Readonly<Record<string, number>>;
}

function failedGateOf(result: UnitResult): string | null {
  const value = result.score?.details['failedGate'];
  return typeof value === 'string' ? value : null;
}

/**
 * Builds per-candidate aggregates from the store's run views.
 *
 * @param candidates - The run's candidates with their outcomes.
 * @param units - Every unit result of the run, all candidates mixed.
 * @returns One aggregate per candidate, in candidate order.
 */
export function aggregateCandidates(
  candidates: readonly CandidateResult[],
  units: readonly UnitResult[],
): CandidateAggregate[] {
  return candidates.map((candidate) => {
    const own = units.filter((u) => u.unit.candidateId === candidate.record.id);
    const summary = summarizeRun(own);
    const completed = own.filter((u) => u.status === 'completed' && u.score !== null);
    const gateFailureCounts: Record<string, number> = {};
    for (const unit of completed) {
      const failed = failedGateOf(unit);
      if (failed !== null) {
        gateFailureCounts[failed] = (gateFailureCounts[failed] ?? 0) + 1;
      }
    }
    const predicted = candidate.record.predictedPeakMib;
    const measured = candidate.peakVramMib;
    return {
      candidate: candidate.record,
      status: candidate.status,
      statusReason: candidate.statusReason,
      offloadSuspectReason: candidate.offloadSuspectReason,
      summary,
      measuredPeakMib: measured,
      predictedPeakMib: predicted,
      vramDeltaPercent:
        measured === null || predicted === null ? null : ((measured - predicted) / predicted) * 100,
      gatesPassed:
        completed.length === 0
          ? null
          : completed.every((unit) => failedGateOf(unit) === null),
      gateFailureCounts,
    };
  });
}

/**
 * Whether a candidate is eligible for the Pareto frontier and the
 * recommendation: it completed (OOM and failure are results, not
 * recommendations), every completed unit passed every gate, and it has
 * a measured quality.
 *
 * @param aggregate - The candidate's aggregate.
 * @returns True when eligible.
 */
export function isGatePassing(aggregate: CandidateAggregate): boolean {
  return (
    aggregate.status === 'completed' &&
    aggregate.gatesPassed === true &&
    aggregate.summary.meanScore !== null
  );
}
